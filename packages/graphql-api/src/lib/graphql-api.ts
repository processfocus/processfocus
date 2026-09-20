import type { PlatformError } from "@effect/platform/Error"
import { NodeFileSystem } from "@effect/platform-node"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { useEngine } from "@envelop/core"
import { type ExecutionArgs, normalizedExecutor } from "@graphql-tools/executor"
import { mergeTypeDefs } from "@graphql-tools/merge"
import type {
  ExecutionResult,
  MaybeAsyncIterable,
  MaybePromise,
} from "@graphql-tools/utils"
import {
  createRemoteJwksSigningKeyProvider,
  extractFromConnectionParams,
  extractFromHeader,
  useJWT,
} from "@graphql-yoga/plugin-jwt"
import type { QueueService } from "@processfocus/runtime"
import { Context, DateTime, Effect, Layer, type ManagedRuntime } from "effect"
import {
  type DocumentNode,
  GraphQLError,
  createSourceEventStream,
  execute,
  getOperationAST,
  parse,
  specifiedRules,
  validate,
  validateSubscriptionArgs,
} from "graphql"
import { DateTimeISOResolver, JSONResolver } from "graphql-scalars"
import {
  type YogaInitialContext,
  type YogaServerInstance,
  createSchema,
  createYoga,
} from "graphql-yoga"
import type { AuthorizationService, CurrentPrincipal } from "@pf/auth-policy"
import type { DocumentStoreService } from "@pf/document-store-service"
import type {
  DraftProcessExecutionQueries,
  FileOperations,
  FlowExecutionOperations,
  FlowQueries,
  OrgQueries,
  ProcessExecutionOperations,
  ProcessQueries,
  ProviderUserQueries,
  ScheduledFlowOperations,
  StepCompletionOperations,
  StepRoleQueries,
  TodoQueries,
  UserDetails,
  WorkflowQueries,
} from "@pf/graphql-db-operations"
import { encodeDelegationAudit } from "@pf/graphql-db-operations"
import type { MissingGeneratedSchemaError } from "@pf/graphql-schema"
import type { OrganisationProvider } from "@pf/process"
import type { RequestTime } from "@pf/request-time"
import type { TodoSummaryComputation } from "@pf/todo-summary"
import { AuthConfig, GRAPHQL_AUDIENCE } from "./auth-config"
import { transformSchemaWithAuthDirective } from "./auth-directive-plugin"
import { recordDashboardActivity } from "./dashboard-activity"
import {
  RealtimeEvent,
  guardRealtimeStream,
  refreshRealtimeContext,
} from "./delegated-realtime"
import { acceptVerifiedGraphqlJwt } from "./delegation-boundary"
import type { DraftProcessEvents } from "./draft-process-events"
import { dynamicSchema } from "./dynamic-resolvers"
import type { ExecutionEvents } from "./execution-events"
import type { ListExportService } from "./list-export"
import type { ProcessEvents } from "./process-events"
import {
  createResolverExecutor,
  deepMerge,
  toSerializableGraphQLExtensions,
} from "./resolver-utils"
import type { DraftProcessExecutionCollectionOps } from "./rxdb/draft-process-execution"
import type { ExecutionCollectionOps } from "./rxdb/execution"
import type { ProcessCollectionOps } from "./rxdb/process"
import type { TodoCollectionOps } from "./rxdb/todo"
import { rxdbSchema } from "./rxdb-resolvers"
import { assertGraphqlSessionBinding } from "./session-binding"
import {
  isProviderUserSession,
  isServiceAccountSession,
} from "./session-guards"
import { systemSchema } from "./system-resolvers"
import type { TodoEvents } from "./todo-events"
import type {
  JWTPayload,
  MergedSchemaDefinition,
  ResolverMap,
  SchemaDefinition,
  ServerContext,
  UserContext,
  YogaSchema,
} from "./types"

// Re-export types for backwards compatibility
export type { ServerContext, UserContext } from "./types"

const hasAsyncIterator = <T>(
  value: MaybeAsyncIterable<T>,
): value is AsyncIterable<T> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function"

const sanitizeGraphQLError = (error: GraphQLError): GraphQLError => {
  const originalError = error.originalError
  if (
    originalError instanceof GraphQLError &&
    Object.keys(originalError.extensions ?? {}).length > 0
  ) {
    return new GraphQLError(originalError.message, {
      nodes: error.nodes ?? null,
      source: error.source ?? null,
      positions: error.positions ?? null,
      path: error.path ?? null,
      extensions: toSerializableGraphQLExtensions(originalError.extensions),
    })
  }

  if (originalError instanceof GraphQLError) {
    return new GraphQLError(originalError.message, {
      nodes: error.nodes ?? null,
      source: error.source ?? null,
      positions: error.positions ?? null,
      path: error.path ?? null,
    })
  }

  const extensions = Object.fromEntries(
    Object.entries(error.extensions ?? {}).filter(
      ([key]) => key !== "originalError",
    ),
  )

  if (Object.keys(extensions).length > 0) {
    return new GraphQLError(error.message, {
      nodes: error.nodes ?? null,
      source: error.source ?? null,
      positions: error.positions ?? null,
      path: error.path ?? null,
      extensions: toSerializableGraphQLExtensions(extensions),
    })
  }

  if (originalError === undefined) {
    if (error.message.includes("QueryPromise")) {
      console.error("GraphQL execution error", error)
    }
    return new GraphQLError(error.message, {
      nodes: error.nodes ?? null,
      source: error.source ?? null,
      positions: error.positions ?? null,
      path: error.path ?? null,
    })
  }

  return new GraphQLError("Unexpected error.", {
    path: error.path ?? null,
  })
}

const sanitizeExecutionResult = <TData>(
  result: ExecutionResult<TData>,
): ExecutionResult<TData> => {
  if (!result.errors || result.errors.length === 0) return result
  return {
    ...result,
    errors: result.errors.map(sanitizeGraphQLError),
  }
}

const sanitizeExecutionOutput = <TData>(
  result: MaybeAsyncIterable<ExecutionResult<TData>>,
): MaybeAsyncIterable<ExecutionResult<TData>> => {
  if (!hasAsyncIterator(result)) return sanitizeExecutionResult(result)

  // Yoga can also call maskError later; this pass is intentionally idempotent
  // and keeps subscription results JSON-safe before they reach graphql-ws.
  return {
    async *[Symbol.asyncIterator]() {
      for await (const value of result) {
        yield sanitizeExecutionResult(value)
      }
    },
  }
}

/**
 * Derive the access_token cookie name from the Origin header.
 * On localhost, cookies are port-suffixed (e.g. access_token_3000) to avoid
 * collisions between multiple local runtime instances.
 */
const accessTokenCookieName = (origin: string | null): string => {
  const envPort = process.env["NEXTJS_PORT"]
  if (envPort) return `access_token_${envPort}`

  if (!origin) return "access_token"
  try {
    const url = new URL(origin)
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port
    ) {
      return `access_token_${url.port}`
    }
  } catch (err) {
    if (process.env["NODE_ENV"] !== "production") {
      console.warn(`[graphql-api] Invalid origin header: ${origin}`, err)
    }
  }
  return "access_token"
}

/**
 * Helper to extract access_token from cookies for WebSocket/HTTP cookie auth
 */
const accessTokenFromCookie = (
  cookieHeader: string | null,
  origin: string | null,
): { token: string } | undefined => {
  if (!cookieHeader) return undefined

  const cookies = cookieHeader.split(";").reduce(
    (acc, cookie) => {
      // Handle cookies with = in the value (e.g., base64-encoded JWTs)
      const [key, ...valueParts] = cookie.trim().split("=")
      const value = valueParts.join("=")
      if (key && value) acc[key] = value
      return acc
    },
    {} as Record<string, string>,
  )

  const cookieName = accessTokenCookieName(origin)
  const token = cookies[cookieName]
  return token ? { token } : undefined
}

/**
 * Type guard to check if serverContext has a request object (for WebSocket upgrades)
 */
const hasRequest = (obj: unknown): obj is { req: Request } =>
  typeof obj === "object" &&
  obj !== null &&
  "req" in obj &&
  obj.req instanceof Request

/**
 * Configuration for the dynamic schema path
 */
export class DynamicSchemaConfig extends Context.Tag(
  "@pf/graphql-api/DynamicSchemaConfig",
)<DynamicSchemaConfig, { readonly schemaPath: string }>() {}

export const securityHeadersPlugin = {
  onResponse: ({ response }: { response: Response }) => {
    response.headers.set("X-Content-Type-Options", "nosniff")
    response.headers.set("Referrer-Policy", "no-referrer")
    response.headers.set("X-Frame-Options", "DENY")
    response.headers.set("Vary", "Authorization, Origin")
    if (!response.headers.has("Content-Security-Policy")) {
      // Because of GraphiQL we can't forbid everything
      response.headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; connect-src 'self' ws: wss: https://unpkg.com/@graphql-yoga/; style-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; font-src 'self' data:; img-src 'self' https://raw.githubusercontent.com/graphql-hive/graphql-yoga/; worker-src 'self' blob:;",
      )
    }
  },
}

const helloSchema = Effect.succeed<SchemaDefinition>({
  typeDefs: /* GraphQL */ `
  type Query {
  hello(name: String = "world"): String!
      }
  `,
  resolvers: {
    Query: {
      hello: (_parent: unknown, { name }: { name: string }) =>
        Effect.succeed(`Hello, ${name}!`),
    },
  },
})

const scalarsSchema = Effect.succeed({
  resolvers: {
    DateTimeISO: DateTimeISOResolver,
    JSON: JSONResolver,
  },
})

export class AppSchemaBuilder extends Context.Tag(
  "@pf/graphql-api/AppSchemaBuilder",
)<
  AppSchemaBuilder,
  {
    toSchema: Effect.Effect<
      YogaSchema,
      MissingGeneratedSchemaError | SqlError | PlatformError,
      | OrgQueries
      | ProcessQueries
      | ProviderUserQueries
      | ProcessExecutionOperations
      | OrganisationProvider
      | DraftProcessExecutionQueries
      | RequestTime
      | SqlClient.SqlClient
      | ResolverRuntime
      | DynamicSchemaConfig
      | StepCompletionOperations
      | FlowQueries
      | QueueService
      | DocumentStoreService
      | WorkflowQueries
    >
  }
>() {}

export const AppSchemaBuilderLive = Layer.effect(
  AppSchemaBuilder,
  Effect.gen(function* () {
    // Build the executor once at this ManagedRuntime boundary. Reusable wrap
    // helpers close over the runtime and never take it as a parameter.
    const runtime = yield* ResolverRuntime
    const executor = createResolverExecutor(runtime)

    const mergeSchemas = (
      schemas: Array<SchemaDefinition>,
    ): Effect.Effect<MergedSchemaDefinition> =>
      Effect.sync(() => {
        const allTypeDefs = schemas
          .map((s) => s.typeDefs)
          .filter((td) => td !== undefined)

        const mergedTypeDefs: DocumentNode =
          allTypeDefs.length > 0
            ? mergeTypeDefs(allTypeDefs)
            : mergeTypeDefs("")

        const allResolvers = schemas
          .map((s) => s.resolvers)
          .filter((r): r is ResolverMap => r !== undefined)

        const mergedResolvers = deepMerge(...allResolvers)

        return {
          typeDefs: mergedTypeDefs,
          resolvers: mergedResolvers,
        }
      })

    return {
      // Not executable alone: root Query/Mutation remain Effect-returning so
      // YogaLive can compose @auth + resolve as one fiber via
      // transformSchemaWithAuthDirective(executor). Call that before serving.
      toSchema: Effect.gen(function* () {
        const hello = yield* helloSchema
        const scalars = yield* scalarsSchema
        const rxdb = yield* rxdbSchema
        const system = yield* systemSchema
        const dynamic = yield* dynamicSchema.pipe(
          Effect.tapError(Effect.logError),
        )

        const merged = yield* mergeSchemas([
          hello,
          scalars,
          rxdb,
          system,
          dynamic,
        ])

        // Nested type resolvers and Subscription.subscribe: Effect → Promise.
        // Root Query/Mutation stay Effect-returning so @auth can compose
        // authorize-then-resolve as one fiber (see transformSchemaWithAuthDirective).
        const wrappedResolvers = executor.wrapResolvers(merged.resolvers)

        return createSchema<UserContext>({
          typeDefs: merged.typeDefs,
          resolvers: wrappedResolvers,
        })
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    }
  }),
)

export class Yoga extends Context.Tag("@pf/graphql-api/Yoga")<
  Yoga,
  YogaServerInstance<ServerContext, UserContext>
>() {}

// Runtime used during resolver execution - includes event services for real-time updates.
// Closed over once via createResolverExecutor at schema/Yoga construction; never
// passed as a parameter into reusable wrap/auth helpers.
export class ResolverRuntime extends Context.Tag(
  "@pf/graphql-api/ResolverRuntime",
)<
  ResolverRuntime,
  ManagedRuntime.ManagedRuntime<
    | OrgQueries
    | ProcessQueries
    | ProviderUserQueries
    | ProcessExecutionOperations
    | OrganisationProvider
    | DraftProcessExecutionQueries
    | DraftProcessExecutionCollectionOps
    | ProcessCollectionOps
    | TodoCollectionOps
    | TodoQueries
    | ExecutionCollectionOps
    | RequestTime
    | UserDetails
    | CurrentPrincipal
    | SqlClient.SqlClient
    | DraftProcessEvents
    | TodoEvents
    | ProcessEvents
    | ExecutionEvents
    | FileOperations
    | FlowExecutionOperations
    | FlowQueries
    | ScheduledFlowOperations
    | QueueService
    | DocumentStoreService
    | StepCompletionOperations
    | StepRoleQueries
    | AuthorizationService
    | ListExportService
    | TodoSummaryComputation,
    unknown
  >
>() {}

export const YogaLive = Layer.effect(
  Yoga,
  Effect.gen(function* () {
    const builder = yield* AppSchemaBuilder
    const baseSchema = yield* builder.toSchema
    const runtime = yield* ResolverRuntime
    const authConfig = yield* AuthConfig
    const executor = createResolverExecutor(runtime)

    // Compose @auth with each root resolver as one Effect (single runPromise).
    // Executor is closed over ManagedRuntime at this boundary.
    const schema = transformSchemaWithAuthDirective(baseSchema, executor)

    const jwtPlugin = useJWT({
      tokenLookupLocations: [
        extractFromHeader({ name: "authorization", prefix: "Bearer" }),
        // Custom connectionParams extractor that also returns the token
        // (extractFromConnectionParams seems to not be working properly)
        (params) => {
          const cp = params.serverContext?.["connectionParams"] as
            | Record<string, unknown>
            | undefined
          if (cp?.["token"] && typeof cp["token"] === "string") {
            return { token: cp["token"] }
          }
          return undefined
        },
        extractFromConnectionParams({ name: "token" }),
        // WebSocket upgrade request headers
        (params) => {
          if (hasRequest(params.serverContext)) {
            if (params.serverContext.req.headers) {
              const authHeader =
                params.serverContext.req.headers.get("authorization")
              if (authHeader?.startsWith("Bearer ")) {
                return { token: authHeader.substring(7) }
              }
              return accessTokenFromCookie(
                params.serverContext.req.headers.get("cookie"),
                params.serverContext.req.headers.get("origin"),
              )
            }
          }
          return undefined
        },
        // HTTP request cookie fallback
        (params) => {
          if (!params?.request?.headers) return undefined
          return accessTokenFromCookie(
            params.request.headers.get("cookie"),
            params.request.headers.get("origin"),
          )
        },
      ],
      signingKeyProviders: [
        createRemoteJwksSigningKeyProvider({
          jwksUri: authConfig.jwksUri,
        }),
      ],
      tokenVerification: {
        issuer: authConfig.issuerUrls,
        algorithms: ["ES256"],
        audience: GRAPHQL_AUDIENCE,
      },
      extendContext: true,
      reject: {
        missingToken: true,
        invalidToken: true,
      },
    })

    const executeWithSpan = (
      args: ExecutionArgs<unknown, Record<string, unknown>, UserContext>,
    ): MaybePromise<MaybeAsyncIterable<ExecutionResult>> => {
      if (
        getOperationAST(args.document, args.operationName)?.operation ===
        "subscription"
      ) {
        return (async () => {
          try {
            if (!args.contextValue)
              throw new GraphQLError("Missing subscription context")
            const initialContext = args.contextValue
            const refresh = (signal?: AbortSignal) =>
              runtime
                .runPromise(
                  refreshRealtimeContext(initialContext),
                  signal ? { signal } : undefined,
                )
                .then((context) => {
                  assertGraphqlSessionBinding(
                    initialContext,
                    context.jwt?.properties,
                  )
                  return context
                })
            const contextValue = await refresh()
            const validated = validateSubscriptionArgs({
              ...args,
              contextValue,
            })
            if (!("operation" in validated)) return { errors: validated }
            const source = await createSourceEventStream(validated)
            if (!(Symbol.asyncIterator in source)) return source
            return guardRealtimeStream(source, {
              context: contextValue,
              refresh,
              deliver: async (event, context, signal) => {
                const contextValue = {
                  ...context,
                  _realtimeAbortSignal: signal,
                }
                const rootValue =
                  event instanceof RealtimeEvent
                    ? await event.prepare(contextValue)
                    : event
                if (rootValue === null) return null
                const result = await execute({
                  ...args,
                  rootValue,
                  contextValue,
                })
                if (result.errors?.length)
                  throw new GraphQLError(
                    "Subscription authorization or delivery failed",
                  )
                return sanitizeExecutionResult(result)
              },
            })
          } catch (error) {
            return {
              errors: [
                error instanceof GraphQLError
                  ? error
                  : new GraphQLError("Subscription authorization failed"),
              ],
            }
          }
        })()
      }
      const executeGraphql = Effect.gen(function* () {
        // Wrap the execution in a parent span and get it to pass to resolvers
        const result = yield* Effect.gen(function* () {
          // Get the current span context
          const currentSpan = yield* Effect.currentSpan

          // Enhance context with span, which we now have.
          const argsWithContext = {
            ...args,
            contextValue: {
              // Need to cast as contextValue could be undefined according to its type,
              // but that can't happen for us.
              ...(args.contextValue as UserContext),
              _effectParentSpan: currentSpan,
            },
          }

          // Execute GraphQL within the parent span context
          return yield* Effect.promise(() =>
            Promise.resolve(normalizedExecutor(argsWithContext)).then(
              sanitizeExecutionOutput,
            ),
          )
        }).pipe(
          Effect.withSpan("graphql.execute", {
            attributes: {
              "graphql.operation.name": args.operationName ?? "anonymous",
            },
          }),
        )

        return result
      })

      return runtime.runPromise(executeGraphql)
    }

    const yoga = createYoga<ServerContext, UserContext>({
      schema,
      cors: {
        origin: "*",
        credentials: true,
      },
      maskedErrors: {
        maskError: (error) => {
          // Don't mask GraphQLErrors - they're already formatted correctly
          if (error instanceof GraphQLError) {
            const sanitized = sanitizeGraphQLError(error)
            if (sanitized.message === "Unexpected error.") {
              console.error(
                "GraphQL unexpected error masked",
                error.originalError,
              )
            }
            return sanitized
          }
          // Mask other errors for security
          console.error("GraphQL unexpected non-GraphQLError masked", error)
          return new GraphQLError("Unexpected error.")
        },
      },
      plugins: [
        jwtPlugin,
        // Plugin to set up user context fields after JWT plugin has run
        {
          onContextBuilding: async ({
            context,
            extendContext,
          }: {
            context: Record<string, unknown>
            extendContext: (extension: Partial<UserContext>) => void
          }) => {
            const jwtContext = context["jwt"] as
              | { payload: JWTPayload }
              | undefined
            const jwt = await runtime
              .runPromise(acceptVerifiedGraphqlJwt(jwtContext?.payload))
              .catch(() => {
                throw new GraphQLError(
                  "Delegated access is unavailable or invalid",
                  {
                    extensions: { code: "UNAUTHENTICATED" },
                  },
                )
              })
            const props = jwt?.properties
            assertGraphqlSessionBinding(context, props)
            await runtime.runPromise(
              recordDashboardActivity(context["request"], jwt),
            )
            const isProviderUser = props !== undefined && "email" in props

            const userId = props?.userId
            const email = isProviderUser ? props.email : undefined

            // Capture request time here so each request gets its own timestamp
            // (not at server startup which would be shared across all requests)
            const requestTime = DateTime.unsafeNow()
            const persistedUserId =
              isProviderUser ||
              (isServiceAccountSession(props) &&
                typeof userId === "string" &&
                userId.startsWith("usr-"))
                ? (userId ?? null)
                : null

            extendContext({
              jwt,
              userId,
              _requestTime: requestTime,
              _userDetails: {
                by:
                  isProviderUserSession(props) && props.delegation
                    ? encodeDelegationAudit({
                        version: 1,
                        ownerUserId: props.userId,
                        ownerEmail: props.email,
                        delegationId: props.delegation.id,
                        generationId: props.delegation.generationId,
                        name: props.delegation.name,
                      })
                    : (email ?? userId ?? "SYSTEM"),
                id: persistedUserId,
              },
            })
          },
        },
        securityHeadersPlugin,
        {
          onResponse: ({ response }) => {
            response.headers.set("Cache-Control", "no-store")
            response.headers.append("Vary", "Cookie")
          },
        },
        useEngine({
          parse,
          validate,
          execute: executeWithSpan,
          subscribe: executeWithSpan,
          specifiedRules,
        }),
      ],
      graphiql: {
        subscriptionsProtocol: "WS",
      },
      // Context function just passes through - actual setup is in onContextBuilding plugin
      context: (
        initialContext: YogaInitialContext & ServerContext,
      ): UserContext => initialContext as unknown as UserContext,
    })

    // Type assertion: we ensure GraphQLContext is available at runtime via executeWithSpan
    return Yoga.of(
      yoga as unknown as YogaServerInstance<ServerContext, UserContext>,
    )
  }),
)
