import { MapperKind, getDirective, mapSchema } from "@graphql-tools/utils"
import { Effect } from "effect"
import type {
  GraphQLFieldConfig,
  GraphQLFieldResolver,
  GraphQLSchema,
} from "graphql"
import {
  Application,
  AuthorizationService,
  type FeatureAction,
  GraphQLField,
  ProviderUserPrincipal,
  ServiceAccountPrincipal,
  Step,
} from "@pf/auth-policy"
import { StepRoleQueries } from "@pf/graphql-db-operations"
import { NotAuthorized } from "@pf/graphql-schema"
import { delegatedRealtimeEnabled } from "./delegated-realtime"
import { isProcessPermissionResolver } from "./dynamic-resolvers"
import {
  type ResolverExecutor,
  type ResolverExecutorContext,
  buildCurrentPrincipal,
  getProcessPathFromStepPath,
} from "./resolver-utils"
import {
  hasDelegation,
  isProviderUserSession,
  isServiceAccountSession,
  rejectUnsupportedDelegationHandoff,
} from "./session-guards"
import type { UserContext } from "./types"

/** Default application ID for feature-based authorization checks */
const DEFAULT_APPLICATION_ID = "default"

/**
 * Build a principal for field authorization based on the user context.
 * Returns ProviderUserPrincipal if the user has an email (provider user),
 * otherwise returns ServiceAccountPrincipal (M2M token).
 */
const buildFieldPrincipal = (
  context: UserContext,
): ProviderUserPrincipal | ServiceAccountPrincipal => {
  const props = context.jwt?.properties
  const roles: readonly string[] = props?.roles ?? []
  if (hasDelegation(props)) {
    const principal = buildCurrentPrincipal(context)
    if (!principal)
      throw new Error("Delegation principal validation is required")
    return principal
  }

  if (isProviderUserSession(props)) {
    // Provider user session - has email
    const orgUnitPath = props.orgUnitPath ?? props.orgUnitId ?? ""
    return new ProviderUserPrincipal(props.email, {
      roles,
      orgUnitId: orgUnitPath,
    })
  }

  // M2M/ServiceAccount session - use clientId for Cedar entity matching
  if (isServiceAccountSession(props)) {
    return new ServiceAccountPrincipal(props.clientId, roles)
  }

  // This should be unreachable: JWT plugin rejects missing/invalid tokens
  // before resolvers run (configured with reject.missingToken: true).
  // Defensive fallback returns anonymous principal which Cedar will deny.
  console.warn(
    "Unexpected: buildFieldPrincipal reached without valid session. " +
      "JWT plugin should have rejected this request.",
  )
  return new ServiceAccountPrincipal("anonymous", [])
}

/**
 * Determine the GraphQL operation type for a field based on its parent type.
 */
const getOperationType = (
  typeName: string,
): "query" | "mutation" | "subscription" => {
  switch (typeName) {
    case "Query":
      return "query"
    case "Mutation":
      return "mutation"
    case "Subscription":
      return "subscription"
    default:
      // For non-root types, default to query (shouldn't happen for @auth)
      return "query"
  }
}

/**
 * Cache for directive metadata per schema (avoids repeated introspection).
 * Uses WeakMap so schemas can be garbage collected.
 */
const directiveCache = new WeakMap<
  GraphQLSchema,
  Map<string, { tag?: string; action?: FeatureAction } | undefined>
>()

/**
 * Get cached directive info for a field.
 * Returns null if not in cache (cache miss).
 * Returns undefined if cached as "no directive".
 * Returns { tag?, action? } if directive was found.
 */
const getCachedDirective = (
  schema: GraphQLSchema,
  fieldKey: string,
): { tag?: string; action?: FeatureAction } | undefined | null => {
  const cache = directiveCache.get(schema)
  if (!cache) return null // null means cache miss - no cache map yet
  if (!cache.has(fieldKey)) return null // null means cache miss - field not checked yet
  return cache.get(fieldKey) // undefined means no directive, { tag?, action? } means has directive
}

/**
 * Set cached directive info for a field.
 */
const setCachedDirective = (
  schema: GraphQLSchema,
  fieldKey: string,
  value: { tag?: string; action?: FeatureAction } | undefined,
): void => {
  let cache = directiveCache.get(schema)
  if (!cache) {
    cache = new Map()
    directiveCache.set(schema, cache)
  }
  cache.set(fieldKey, value)
}

/**
 * Lift a GraphQL resolver result into an Effect so it can be composed with
 * the authorization check in a single fiber.
 */
const liftResolverResult = (
  result: unknown,
): Effect.Effect<unknown, unknown, never> => {
  if (Effect.isEffect(result)) {
    return result as Effect.Effect<unknown, unknown, never>
  }
  if (
    result !== null &&
    result !== undefined &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    return Effect.tryPromise({
      try: () => result as Promise<unknown>,
      catch: (cause) => cause,
    })
  }
  return Effect.succeed(result)
}

/**
 * Transform schema to add authorization checks for fields with @auth directive.
 *
 * Auth and the original resolver are composed as one Effect and executed with a
 * single {@link ResolverExecutor.runWithFieldContext} call so scoping
 * and fiber lifecycle are not duplicated.
 *
 * The executor must be built at the ManagedRuntime boundary; this function does
 * not take a ManagedRuntime parameter.
 */
export const transformSchemaWithAuthDirective = <R>(
  schema: GraphQLSchema,
  executor: ResolverExecutor<R>,
): GraphQLSchema => {
  return mapSchema(schema, {
    [MapperKind.COMPOSITE_FIELD]: (
      fieldConfig: GraphQLFieldConfig<unknown, UserContext>,
      fieldName: string,
      typeName: string,
    ): GraphQLFieldConfig<unknown, UserContext> => {
      const fieldKey = `${typeName}.${fieldName}`
      const processPermission =
        (getDirective(schema, fieldConfig, "processPermission")?.length ?? 0) >
        0
      if (processPermission) {
        if (getDirective(schema, fieldConfig, "auth")?.length) {
          throw new Error(
            `@processPermission on ${fieldKey} cannot be combined with @auth`,
          )
        }
        if (
          typeName !== "Mutation" ||
          typeName !== schema.getMutationType()?.name ||
          !isProcessPermissionResolver(fieldName, fieldConfig.resolve)
        ) {
          throw new Error(
            `@processPermission on ${fieldKey} requires a generated process command resolver`,
          )
        }
      }

      // Only wrap root operation types
      if (
        typeName !== "Query" &&
        typeName !== "Mutation" &&
        typeName !== "Subscription"
      ) {
        return fieldConfig
      }

      const cachedResult = getCachedDirective(schema, fieldKey)

      let authDirective: { tag?: string; action?: FeatureAction } | undefined
      if (cachedResult === null) {
        // Cache miss - get directive and cache result
        const directives = getDirective(schema, fieldConfig, "auth")
        authDirective =
          directives && directives.length > 0
            ? (directives[0] as { tag?: string; action?: FeatureAction })
            : undefined
        setCachedDirective(schema, fieldKey, authDirective)
      } else {
        authDirective = cachedResult
      }

      // Validate @auth directive: must have exactly one of 'tag' or 'action'
      if (authDirective && !authDirective.tag && !authDirective.action) {
        throw new Error(
          `@auth directive on ${fieldKey} must specify either 'tag' or 'action'`,
        )
      }
      if (authDirective?.tag && authDirective?.action) {
        throw new Error(
          `@auth directive on ${fieldKey} cannot specify both 'tag' and 'action'`,
        )
      }

      // Unmarked root fields authorize here; marked mutations authorize inside
      // the process command using live execution facts.
      // tag is optional - only set if @auth(tag: "...") directive is present
      // action is optional - for feature-based authorization
      const tag = authDirective?.tag
      const featureAction = authDirective?.action
      // Generated SDL binds an operation to its actual Step, never to an
      // access category. Eligibility comes from persisted step attributes.
      const stepDirective = getDirective(schema, fieldConfig, "step")?.[0]
      const stepPath =
        typeof stepDirective?.["path"] === "string"
          ? stepDirective["path"]
          : undefined
      // Subscribe must be authorized before acquiring a source, as well as resolve.
      const wrapAuthorized =
        (
          originalResolver:
            | GraphQLFieldResolver<unknown, UserContext>
            | undefined,
        ): GraphQLFieldResolver<unknown, UserContext> =>
        (source, args, context, info) => {
          const operationType = getOperationType(typeName)
          const principal = buildFieldPrincipal(context)
          const parentSpan = context._effectParentSpan

          const authCheck = Effect.gen(function* () {
            if (
              context.jwt?.properties &&
              "awsRole" in context.jwt.properties &&
              (fieldName === "requestRole" || operationType === "subscription")
            ) {
              yield* rejectUnsupportedDelegationHandoff(
                context.jwt.properties,
                fieldName,
              )
            }
            if (
              (context.jwt?.properties.workload ||
                (context.jwt?.properties &&
                  "awsRole" in context.jwt.properties)) &&
              ((operationType === "mutation" &&
                featureAction?.startsWith("administer") &&
                // Preferences neither issue credentials nor change authority.
                // The ordinary Cedar feature check below still applies.
                fieldName !== "updateNotificationPreferences" &&
                // Non-production workload setup may invite fresh users through
                // normal registration. This never authorizes the operation:
                // administerUsers still passes through Cedar below.
                !(
                  context.jwt?.properties.workload &&
                  isServiceAccountSession(context.jwt.properties) &&
                  process.env["PF_STAGE"] &&
                  process.env["PF_STAGE"] !== "production" &&
                  process.env["PF_STAGE"] !== "prod" &&
                  ["createInvitation", "generateRegistrationLink"].includes(
                    fieldName,
                  )
                )) ||
                featureAction === "databaseShell")
            ) {
              return yield* new NotAuthorized({
                action: fieldName,
                resource: fieldKey,
                message: "Workload access cannot administer credentials",
              })
            }
            if (
              (operationType === "subscription" &&
                !(yield* delegatedRealtimeEnabled)) ||
              [
                "subscriptionTransport",
                "requestDownloadUrl",
                "requestUploadUrl",
                "requestDatabaseUploadUrl",
                "exportListCsv",
              ].includes(fieldName)
            ) {
              yield* rejectUnsupportedDelegationHandoff(
                context.jwt?.properties,
                fieldName,
              )
            }
            if (processPermission) {
              if (!context.jwt) {
                return yield* new NotAuthorized({
                  action: operationType,
                  resource: fieldKey,
                  message: "Authentication is required",
                })
              }
              return
            }

            const auth = yield* AuthorizationService

            let allowed: boolean
            if (featureAction) {
              // Feature-based authorization: use semantic action on Application
              const application = new Application(DEFAULT_APPLICATION_ID)
              allowed = yield* auth.canAccessFeature(
                principal,
                application,
                featureAction,
              )
            } else {
              // Tag-based authorization: use field with optional tag
              let step: Step | undefined
              if (stepPath) {
                const queries = yield* StepRoleQueries
                const info = yield* queries.queryRolePathsByStepPath(stepPath)
                step = new Step({
                  stepPath,
                  processPath: getProcessPathFromStepPath(stepPath),
                  rolePath: info.rolePath,
                  startsProcess: info.startsProcess,
                  embedded: info.embedded,
                })
              }
              const resource = new GraphQLField(fieldKey, tag, step)
              allowed = yield* auth.canAccessField(
                principal,
                resource,
                operationType,
              )
            }

            if (!allowed) {
              yield* Effect.logWarning("Field authorization denied").pipe(
                Effect.annotateLogs({
                  field: fieldKey,
                  authMethod: featureAction ? "feature" : "tag",
                  authValue: featureAction ?? tag ?? "none",
                  operationType,
                  principalType: principal.uid.type,
                  principalId: principal.uid.id,
                }),
              )
              const deniedResource = featureAction
                ? `PF::Application::"${DEFAULT_APPLICATION_ID}"`
                : fieldKey
              const deniedMessage = featureAction
                ? `Not authorized: ${principal.uid.type}::${principal.uid.id} has no permission to use feature ${featureAction}`
                : `Not authorized: ${principal.uid.type}::${principal.uid.id} has no permission to use field ${fieldKey}`
              return yield* new NotAuthorized({
                action: featureAction ?? operationType,
                resource: deniedResource,
                message: deniedMessage,
              })
            }

            return allowed
          }).pipe(
            Effect.withSpan("cedar.authorize", {
              parent: parentSpan,
              attributes: {
                "cedar.field": fieldKey,
                "cedar.action": featureAction ?? operationType,
                "cedar.principal.type": principal.uid.type,
                "cedar.principal.id": principal.uid.id,
                "cedar.authMethod": featureAction ? "feature" : "tag",
                "cedar.authValue": featureAction ?? tag ?? "none",
              },
            }),
          )

          const resolverEffect = Effect.suspend(() => {
            if (originalResolver) {
              return liftResolverResult(
                originalResolver(source, args, context, info),
              )
            }
            if (source && typeof source === "object" && fieldName in source) {
              return Effect.succeed(
                (source as Record<string, unknown>)[fieldName],
              )
            }
            return Effect.succeed(undefined)
          })

          // Single fiber: authorize then resolve under one runWithFieldContext.
          // Auth needs AuthorizationService; the executor's closed-over R must
          // provide it (ResolverRuntime does). GraphQL's erase of field Effect
          // requirements means we assert coverage here rather than free-quantify R.
          const composed = authCheck.pipe(Effect.andThen(resolverEffect))

          return executor.runWithFieldContext(
            composed as Effect.Effect<
              unknown,
              unknown,
              R | ResolverExecutorContext
            >,
            {
              // Outer span name matches wrapResolver field spans for nested fields
              spanName: fieldName,
              parentSpan,
              requestTime: context._requestTime,
              userDetails: context._userDetails,
              session: context.jwt?.properties,
              principal: buildCurrentPrincipal(context),
              signal: context._realtimeAbortSignal,
              // Neutral label: failures may be auth or post-auth resolver body.
              logLabel: "GraphQL field failure",
            },
          )
        }

      return {
        ...fieldConfig,
        resolve: wrapAuthorized(fieldConfig.resolve),
        ...(fieldConfig.subscribe
          ? { subscribe: wrapAuthorized(fieldConfig.subscribe) }
          : {}),
      }
    },
  })
}
