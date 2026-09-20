import {
  type DateTime,
  Effect,
  type ManagedRuntime,
  Option,
  Schema,
  SchemaAST,
  type Tracer,
} from "effect"
import { ArrayFormatter, type ParseError } from "effect/ParseResult"
import type { GraphQLFieldResolver, GraphQLResolveInfo } from "graphql"
import {
  CurrentPrincipal,
  DelegationPrincipal,
  ProviderUserPrincipal,
  type UserPrincipal,
} from "@pf/auth-policy"
import type { ProviderUserSession, Session } from "@pf/auth-session"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import type { ValidationError } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { hasDelegation } from "./session-guards"
import {
  extractErrorFromFiberFailure,
  toGraphQLError,
  toSerializableGraphQLExtensions,
} from "./to-graphql-error"
import type { EffectFieldResolver, ResolverMap, UserContext } from "./types"

// Re-export so existing importers of resolver-utils keep working.
export { toSerializableGraphQLExtensions }

/** Type guard to check if session is a provider user session */
const isProviderUserSession = (
  props: Session | undefined,
): props is ProviderUserSession => {
  return props !== undefined && "email" in props
}

/**
 * Build a ProviderUserPrincipal (or null) from the user context.
 * Returns null for service accounts or unauthenticated requests.
 */
export const buildCurrentPrincipal = (
  context: UserContext,
): UserPrincipal | null => {
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
  return null
}

/** Services the resolver executor always scopes via FiberRefs. */
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
 * FiberRef services for `runWithFieldContext`).
 */
export interface ResolverExecutor<R = never> {
  /**
   * Run an Effect with RequestTime, UserDetails, and CurrentPrincipal FiberRefs
   * from the GraphQL request context. Single runPromise boundary.
   */
  readonly runWithFieldContext: <A, E>(
    effect: Effect.Effect<A, E, R | ResolverExecutorContext>,
    options: {
      readonly spanName: string
      readonly parentSpan: Tracer.Span | undefined
      readonly requestTime: DateTime.Utc
      readonly userDetails: UserDetailsValue
      readonly principal: UserPrincipal | null
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
   * Run an Effect through the closed-over ManagedRuntime without field FiberRefs.
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
 * FiberRefs only). Callers must use a ManagedRuntime that includes
 * {@link ResolverExecutorContext} services; that is enforced at the
 * composition sites that yield those FiberRefs.
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
      readonly principal: UserPrincipal | null
      readonly logLabel?: string
      readonly signal?: AbortSignal | undefined
    },
  ): Promise<A> => {
    const effectWithSpan = effect.pipe(
      Effect.withSpan(options.spanName, { parent: options.parentSpan }),
    )

    // Yield FiberRef services then scope request values. The closed-over
    // runtime must provide ResolverExecutorContext; remaining requirements
    // of `effect` stay in R.
    const withFieldRefs = Effect.gen(function* () {
      const requestTimeRef = yield* RequestTime
      const userDetailsRef = yield* UserDetails
      const principalRef = yield* CurrentPrincipal
      return yield* effectWithSpan.pipe(
        Effect.locally(requestTimeRef, options.requestTime),
        Effect.locally(userDetailsRef, options.userDetails),
        Effect.locally(principalRef, options.principal),
      )
    }) as Effect.Effect<A, E, R>

    return runtime
      .runPromise(
        withFieldRefs,
        options.signal ? { signal: options.signal } : undefined,
      )
      .catch((fiberFailure) => {
        // Convert errors after Effect runtime to preserve GraphQLError extensions.
        // Effect wraps errors in FiberFailure; extract then map via shared helper.
        const error = extractErrorFromFiberFailure(fiberFailure)
        console.error(options.logLabel ?? "GraphQL resolver failure", error)
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

/**
 * Helper to check if a segment is a key object
 */
const isKeyObject = (segment: unknown): segment is { key: PropertyKey } =>
  typeof segment === "object" &&
  segment !== null &&
  "key" in segment &&
  typeof segment.key !== "undefined"

/**
 * Extracts validation errors from an Effect Schema ParseError.
 * Field path is returned in dot notation (e.g., "address.city").
 */
export const extractValidationErrors = (
  parseError: ParseError,
): ValidationError[] => {
  const formatted = ArrayFormatter.formatErrorSync(parseError)

  return formatted.map((issue) => ({
    field: issue.path
      .map((segment) =>
        isKeyObject(segment) ? String(segment.key) : String(segment),
      )
      .join("."),
    message: issue.message,
  }))
}

export const getSubmissionFields = (fields: Schema.Struct.Fields) =>
  submissionSchemaSync(Schema.Struct(fields)).fields

const astChildKeys = [
  "type",
  "types",
  "from",
  "to",
  "elements",
  "rest",
] as const

const isAst = (value: unknown): value is SchemaAST.AST =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof (value as { readonly _tag?: unknown })._tag === "string"

const getRawAnnotation = (
  value: { readonly annotations?: SchemaAST.Annotations },
  annotationId: symbol,
): Option.Option<unknown> => {
  const annotation = value.annotations?.[annotationId]
  return annotation === undefined ? Option.none() : Option.some(annotation)
}

export const getSchemaAnnotationDeep = (
  schema: Schema.Struct.Fields[string],
  annotationId: symbol,
): Option.Option<unknown> => {
  const visit = (
    ast: SchemaAST.AST,
    seen: Set<SchemaAST.AST>,
  ): Option.Option<unknown> => {
    const direct = SchemaAST.getAnnotation(ast, annotationId)
    if (Option.isSome(direct)) return direct
    if (seen.has(ast)) return Option.none()
    seen.add(ast)

    // This walks known Effect Schema AST shapes used by form schemas. If Effect
    // changes wrapper shapes, add traversal coverage and tests here so
    // permission annotations cannot be hidden by an unsupported wrapper.
    if (SchemaAST.isSuspend(ast)) {
      const result = visit(ast.f(), seen)
      if (Option.isSome(result)) return result
    }

    const record = ast as unknown as Record<string, unknown>
    if (Array.isArray(record["propertySignatures"])) {
      for (const property of record["propertySignatures"]) {
        if (typeof property !== "object" || property === null) continue
        const propertyRecord = property as {
          readonly annotations?: SchemaAST.Annotations
          readonly type?: unknown
        }
        const propertyAnnotation = getRawAnnotation(
          propertyRecord,
          annotationId,
        )
        if (Option.isSome(propertyAnnotation)) return propertyAnnotation
        if (isAst(propertyRecord.type)) {
          const result = visit(propertyRecord.type, seen)
          if (Option.isSome(result)) return result
        }
      }
    }

    if (Array.isArray(record["indexSignatures"])) {
      for (const signature of record["indexSignatures"]) {
        if (typeof signature !== "object" || signature === null) continue
        const signatureRecord = signature as {
          readonly parameter?: unknown
          readonly type?: unknown
        }
        for (const child of [signatureRecord.parameter, signatureRecord.type]) {
          if (!isAst(child)) continue
          const result = visit(child, seen)
          if (Option.isSome(result)) return result
        }
      }
    }

    for (const key of astChildKeys) {
      const child = record[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (!isAst(item)) continue
          const result = visit(item, seen)
          if (Option.isSome(result)) return result
        }
        continue
      }
      if (isAst(child)) {
        const result = visit(child, seen)
        if (Option.isSome(result)) return result
      }
    }

    return Option.none()
  }

  return visit(
    Schema.isPropertySignature(schema)
      ? Schema.Struct({ field: schema }).ast
      : schema.ast,
    new Set(),
  )
}

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
