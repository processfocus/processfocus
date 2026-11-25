import {
  Cause,
  type DateTime,
  Effect,
  Exit,
  type ManagedRuntime,
  type Tracer,
} from "effect"
import type { GraphQLFieldResolver, GraphQLResolveInfo } from "graphql"
import {
  CurrentPrincipal,
  DelegationPrincipal,
  ProviderUserPrincipal,
  ServiceAccountPrincipal,
  type UserPrincipal,
} from "@pf/auth-policy"
import type { Session } from "@pf/auth-session"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import { LookupFieldNotFoundError } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { errorDiagnostic } from "./error-diagnostic"
import { hasDelegation, isProviderUserSession } from "./session-guards"
import {
  extractErrorFromCause,
  isExpectedGraphQLError,
  toGraphQLError,
  toSerializableGraphQLExtensions,
} from "./to-graphql-error"
import type { EffectFieldResolver, ResolverMap, UserContext } from "./types"

// Re-export so existing importers of resolver-utils keep working.
export { toSerializableGraphQLExtensions }

type GraphqlLogIdentity = {
  readonly userId?: string
  readonly rolePath?: string
  readonly orgUnitId?: string
  readonly orgUnitPath?: string
}

export const graphqlLogIdentity = (
  persistedUserId: string | null,
  session: Session | undefined,
): GraphqlLogIdentity => {
  // Cedar provider-user IDs and the audit "by" field can be email addresses.
  const userId = persistedUserId ?? session?.userId
  const switchedRole = isProviderUserSession(session)
    ? (session.switchedRole ?? session.temporaryRoleAuthority?.role)
    : undefined
  const rolePath =
    switchedRole ??
    (session?.roles?.length === 1 ? session.roles[0] : undefined)
  return {
    ...(userId !== undefined && { userId }),
    ...(rolePath !== undefined && { rolePath }),
    ...(session?.orgUnitId !== undefined && { orgUnitId: session.orgUnitId }),
    ...(session?.orgUnitPath !== undefined && {
      orgUnitPath: session.orgUnitPath,
    }),
  }
}

/**
 * Preserve the verified principal type, including direct machine authority.
 */
export const buildCurrentPrincipal = (
  context: UserContext,
): UserPrincipal | ServiceAccountPrincipal | null => {
  const props = context.jwt?.properties
  if (hasDelegation(props)) {
    if (!isProviderUserSession(props) || !props.delegation) return null
    return new DelegationPrincipal(props.delegation.id, {
      owner: props.email,
      name: props.delegation.name,
      roles: props.roles,
      orgUnitId: props.orgUnitPath,
    })
  }
  if (isProviderUserSession(props)) {
    const orgUnitPath = props.orgUnitPath ?? props.orgUnitId ?? ""
    const roles: readonly string[] = props.roles ?? []
    return new ProviderUserPrincipal(props.email, {
      roles,
      orgUnitId: orgUnitPath,
    })
  }
  if (props && "clientId" in props)
    return new ServiceAccountPrincipal(props.clientId, props.roles ?? [])
  return null
}

/** Services the resolver executor provides from each request context. */
export type ResolverExecutorContext =
  | RequestTime
  | UserDetails
  | CurrentPrincipal

/**
 * Capability for running GraphQL field Effects and wrapping resolvers.
 * Built once at the runtime boundary so reusable helpers never take a
 * ManagedRuntime parameter.
 *
 * `R` is the environment closed over at {@link createResolverExecutor}
 * construction time. `runPromise` / `runWithFieldContext` only accept Effects
 * whose remaining requirements are satisfied by that environment (plus field
 * services for `runWithFieldContext`).
 */
export interface ResolverExecutor<R = never> {
  /**
   * Run an Effect with RequestTime, UserDetails, and CurrentPrincipal services
   * from the GraphQL request context. Single runPromise boundary.
   */
  readonly runWithFieldContext: <A, E>(
    effect: Effect.Effect<A, E, R | ResolverExecutorContext>,
    options: {
      readonly spanName: string
      readonly parentSpan: Tracer.Span | undefined
      readonly requestTime: DateTime.Utc
      readonly userDetails: UserDetailsValue
      readonly session?: Session | undefined
      readonly principal: UserPrincipal | ServiceAccountPrincipal | null
      readonly logLabel?: string
      readonly signal?: AbortSignal | undefined
    },
  ) => Promise<A>

  /**
   * Recursively wrap a resolver map so Effect-returning resolvers run via
   * {@link runWithFieldContext}. Runtime is closed over at construction.
   */
  // biome-ignore lint/suspicious/noExplicitAny: dynamic resolver wrapping for GraphQL IResolvers
  readonly wrapResolvers: (resolvers: ResolverMap) => Record<string, any>

  /**
   * Run an Effect through the closed-over ManagedRuntime without field services.
   * Used for long-lived subscription setup and per-event authorization filters.
   */
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal: AbortSignal },
  ) => Promise<A>
}

/**
 * Build a {@link ResolverExecutor} that closes over `runtime`.
 * Call once at the ManagedRuntime boundary (schema / Yoga construction).
 *
 * `R` is the runtime's full provided environment (not narrowed to field
 * services only). `runWithFieldContext` supplies the
 * {@link ResolverExecutorContext} services from its request options.
 */
export const createResolverExecutor = <R>(
  runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
): ResolverExecutor<R> => {
  const runWithFieldContext = <A, E>(
    effect: Effect.Effect<A, E, R | ResolverExecutorContext>,
    options: {
      readonly spanName: string
      readonly parentSpan: Tracer.Span | undefined
      readonly requestTime: DateTime.Utc
      readonly userDetails: UserDetailsValue
      readonly session?: Session | undefined
      readonly principal: UserPrincipal | ServiceAccountPrincipal | null
      readonly logLabel?: string
      readonly signal?: AbortSignal | undefined
    },
  ): Promise<A> => {
    const identity = graphqlLogIdentity(options.userDetails.id, options.session)
    const effectWithSpan = effect.pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          const error = extractErrorFromCause(cause)
          const expected =
            cause.reasons.length > 0 &&
            cause.reasons.every(
              (reason) =>
                Cause.isFailReason(reason) &&
                isExpectedGraphQLError(reason.error),
            )
          const logFailure = expected ? Effect.logWarning : Effect.logError
          yield* logFailure(options.logLabel ?? "GraphQL resolver failure", {
            field: options.spanName,
            traceId: span.traceId,
            spanId: span.spanId,
            userId: identity.userId,
            error: errorDiagnostic(error),
            ...(error instanceof LookupFieldNotFoundError && {
              formPath: error.formStep,
              fieldName: error.fieldName,
            }),
          })
        }),
      ),
      Effect.withSpan(options.spanName, { parent: options.parentSpan }),
      Effect.annotateLogs(identity),
    )

    const withFieldRefs = effectWithSpan.pipe(
      Effect.provideService(RequestTime, options.requestTime),
      Effect.provideService(UserDetails, options.userDetails),
      Effect.provideService(CurrentPrincipal, options.principal),
    )

    return runtime
      .runPromiseExit(
        withFieldRefs,
        options.signal ? { signal: options.signal } : undefined,
      )
      .then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        const error = extractErrorFromCause(exit.cause)
        throw toGraphQLError(error)
      })
  }

  const runPromise = <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal: AbortSignal },
  ): Promise<A> => runtime.runPromise(effect, options)

  /**
   * Wraps a single resolver to execute Effects with the closed-over runtime.
   */
  const wrapResolver = (resolver: EffectFieldResolver | unknown): unknown => {
    if (typeof resolver === "function") {
      return (
        parent: Record<PropertyKey, never>,
        args: unknown,
        context: UserContext,
        info: GraphQLResolveInfo,
      ) => {
        const result = (
          resolver as GraphQLFieldResolver<
            Record<PropertyKey, never>,
            UserContext
          >
        )(parent, args, context, info)
        if (Effect.isEffect(result)) {
          // GraphQL IResolvers erase Effect requirements; the closed-over
          // runtime must still provide whatever the resolver body needs.
          return runWithFieldContext(
            result as Effect.Effect<unknown, unknown, R>,
            {
              spanName: info?.fieldName ?? "unknown",
              parentSpan: context._effectParentSpan,
              requestTime: context._requestTime,
              userDetails: context._userDetails,
              session: context.jwt?.properties,
              principal: buildCurrentPrincipal(context),
              signal: context._realtimeAbortSignal,
            },
          )
        }
        return result
      }
    }

    return resolver
  }

  /**
   * Wraps a subscription resolver to execute Effects with the closed-over runtime.
   * Subscriptions are long-lived connections, unlike request-scoped resolvers.
   */
  const wrapSubscription = (subscription: unknown): unknown => {
    if (
      subscription &&
      typeof subscription === "object" &&
      "subscribe" in subscription &&
      typeof subscription.subscribe === "function"
    ) {
      const subscribeFn = subscription.subscribe as (
        ...args: unknown[]
      ) => unknown

      return {
        ...subscription,
        subscribe: async (...args: unknown[]) => {
          const result = subscribeFn(...args)

          if (Effect.isEffect(result)) {
            // Same GraphQL requirement erasure as wrapResolver above.
            return await runPromise(
              (result as Effect.Effect<unknown, unknown, R>).pipe(
                Effect.mapError(toGraphQLError),
              ),
            )
          }

          return result
        },
      }
    }

    return subscription
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic resolver wrapping for GraphQL IResolvers
  const wrapResolvers = (resolvers: ResolverMap): Record<string, any> => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic resolver wrapping
    const wrapped: Record<string, any> = {}

    for (const [key, value] of Object.entries(resolvers)) {
      // Root Query/Mutation field resolvers stay Effect-returning so
      // transformSchemaWithAuthDirective can compose auth + resolve as one
      // Effect and execute them with a single runWithFieldContext call.
      if (key === "Query" || key === "Mutation") {
        wrapped[key] = value
        continue
      }

      if (key === "Subscription" && value && typeof value === "object") {
        wrapped[key] = {}
        for (const [subKey, subValue] of Object.entries(value)) {
          wrapped[key][subKey] = wrapSubscription(subValue)
        }
        continue
      }

      if (
        value &&
        typeof value === "object" &&
        !Effect.isEffect(value) &&
        !Array.isArray(value) &&
        typeof value !== "function" &&
        !("_tag" in value)
      ) {
        wrapped[key] = wrapResolvers(value as ResolverMap)
      } else {
        wrapped[key] = wrapResolver(value)
      }
    }

    return wrapped
  }

  return {
    runWithFieldContext,
    wrapResolvers,
    runPromise,
  }
}

export {
  extractValidationErrors,
  getSchemaAnnotationDeep,
  getSubmissionFields,
} from "@pf/form-submission-schema"

/**
 * Extract process path from step path.
 * Step path format: "/orgUnit/processName/stepName"
 * Process path format: "/orgUnit/processName"
 */
export const getProcessPathFromStepPath = (stepPath: string): string => {
  const lastSlash = stepPath.lastIndexOf("/")
  return lastSlash > 0 ? stepPath.slice(0, lastSlash) : stepPath
}

/**
 * Deep merge objects, with later objects overwriting earlier ones.
 */
export const deepMerge = <T extends object[]>(...objects: T): T[number] => {
  // biome-ignore lint/suspicious/noExplicitAny: legacy code
  const result: any = {}

  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(result[key], value)
      } else {
        result[key] = value
      }
    }
  }

  return result
}
