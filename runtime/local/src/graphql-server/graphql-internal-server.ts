import { timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as utilParseArgs } from "node:util"
import type { ExecutionArgs } from "@envelop/types"
import type { ServerWebSocket } from "bun"
import {
  Data,
  Effect,
  Context as EffectContext,
  Exit,
  Layer,
  Metric,
  Option,
  Schedule,
  Schema,
} from "effect"
import { GraphQLError } from "graphql"
import type { SubscribePayload, Context as WsContext } from "graphql-ws"
import { handleProtocols, makeHandler } from "graphql-ws/use/bun"
import { DatabaseConnectionInfo } from "@pf/db-info"
import {
  formatContentDisposition,
  hasInvalidDownloadFilename,
} from "@pf/document-store-service"
import {
  type ExecutionChangeEvent,
  ExecutionCollectionOps,
  ExecutionEvents,
  type ProcessChangeEvent,
  ProcessCollectionOps,
  ProcessEvents,
  ResolverRuntime,
  type TodoChangeEvent,
  TodoCollectionOps,
  TodoEvents,
  Yoga,
} from "@pf/graphql-api"
import { FileOperations } from "@pf/graphql-db-operations"
import { PullCheckpointMode } from "@pf/graphql-schema"
import { makeServerPluginWebhookRouter } from "@pf/job-handler"
import { TodoSummaryComputation } from "@pf/todo-summary"
import {
  type NoAvailablePortError,
  type PortInUseError,
  type ServerStartError,
  serveOnExactPort,
  serveWithPortFallback,
} from "../server-utils"
import {
  LocalDocumentStoreConfig,
  generateLocalDocumentStoreToken,
} from "../services/local-document-store"
import { DEFAULT_GRAPHQL_PORT } from "../services/port-file"

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Uses Node.js crypto.timingSafeEqual for constant-time comparison.
 * Returns false if strings have different lengths (also in constant time).
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    // timingSafeEqual throws if buffers have different lengths
    // Return false in constant time
    return false
  }
}

/**
 * Simple mutex for serializing async operations.
 * Ensures only one operation runs at a time, with proper error isolation.
 *
 * Note: We use a plain Promise-based mutex instead of Effect.Semaphore because
 * this runs in graphql-ws's onSubscribe callback which expects normal async/await
 * error propagation. Effect.tryPromise wraps errors in UnknownException which
 * breaks the error message propagation that graphql-ws needs.
 */
class Mutex {
  private current = Promise.resolve()

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.current
    let resolveNext: (() => void) | undefined
    this.current = new Promise((resolve) => {
      resolveNext = resolve
    })

    try {
      await previous
      return await fn()
    } finally {
      if (resolveNext) resolveNext()
    }
  }
}

/**
 * Service for providing the callback secret used for internal API authentication.
 * This allows the secret to be injected via layers in tests instead of environment variables.
 */
export class CallbackSecret extends EffectContext.Tag(
  "@pf/runtime-local/CallbackSecret",
)<CallbackSecret, Option.Option<string>>() {}

/**
 * Live layer that reads the internal API secret from the INTERNAL_API_SECRET environment variable.
 */
export const CallbackSecretLive = Layer.effect(
  CallbackSecret,
  Effect.sync(() => Option.fromNullable(process.env["INTERNAL_API_SECRET"])),
)

// OpenTelemetry metrics for tracking WebSocket connections and subscriptions
const activeWebSocketConnections = Metric.gauge(
  "graphql.websocket.connections.active",
  {
    description: "Number of active WebSocket connections (subscribers)",
  },
)

const activeGraphqlSubscriptions = Metric.gauge(
  "graphql.subscriptions.active",
  {
    description: "Number of active GraphQL subscriptions",
  },
)

// CLI argument parsing
class InvalidUsageError extends Data.TaggedError("InvalidUsageError")<{
  _: undefined
}> {}

const ParsedArgsSchema = Schema.Struct({
  port: Schema.optional(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(0, 65535)),
  ),
  org: Schema.String,
})

type ParsedArgs = Schema.Schema.Type<typeof ParsedArgsSchema>

export const parseArgs = (
  args: string[],
): Effect.Effect<ParsedArgs, InvalidUsageError> =>
  Effect.gen(function* () {
    const parseResult = yield* Effect.try({
      try: () =>
        utilParseArgs({
          args,
          options: {
            port: { type: "string", short: "p" },
            org: { type: "string", short: "o" },
          },
          strict: true,
          allowPositionals: false,
        }),
      catch: () => new InvalidUsageError({ _: undefined }),
    })

    const org = parseResult.values.org ?? process.env["PF_ORG"]
    if (!org) {
      console.error(
        "Error: --org is required (or set PF_ORG environment variable)",
      )
      return yield* new InvalidUsageError({ _: undefined })
    }

    return yield* Schema.decodeUnknown(ParsedArgsSchema)({
      port: parseResult.values.port,
      org,
    }).pipe(Effect.mapError(() => new InvalidUsageError({ _: undefined })))
  })

/**
 * Extended WebSocket context that includes the original HTTP upgrade request.
 * This allows access to cookies and headers from the upgrade request.
 */
interface BunWebSocketExtra extends Record<PropertyKey, unknown> {
  readonly socket: ServerWebSocket<{ request: Request }>
}

/**
 * Creates the server Effect that starts the GraphQL server.
 *
 * @param port - Optional explicit port. If Some, use exact port (fails if in use).
 *               If None, use default port with fallback.
 * @returns Effect that resolves to the started server
 *
 * This Effect requires Yoga and DatabaseConnectionInfo services to be provided.
 */
export const makeServerEffect = (port: Option.Option<number>) =>
  Effect.gen(function* () {
    const yoga = yield* Yoga
    const resolverRuntime = yield* ResolverRuntime
    const routeServerPluginWebhook = yield* makeServerPluginWebhookRouter

    // Get callback secret from service (allows injection via layers in tests)
    const callbackSecret = yield* CallbackSecret

    // Get document store config for file upload/download endpoints
    const docStoreConfig = yield* LocalDocumentStoreConfig

    // Log database connection
    const dbConnectionInfo = yield* DatabaseConnectionInfo
    yield* Effect.log(`💾 Connecting to database: ${dbConnectionInfo}`)

    // Track active subscriptions for debugging
    const activeSubscriptions = new Map<
      string,
      { operation: string; startTime: Date; connectionId: number }
    >()
    let connectionCounter = 0
    let connectionIdCounter = 0
    const connectionToId = new WeakMap<object, number>()

    // Track WebSocket to context mapping for cleanup
    const wsToContext = new WeakMap<
      object,
      WsContext<undefined, BunWebSocketExtra>
    >()

    // Mutex for serializing contextFactory calls during subscription setup.
    // This prevents a race condition where multiple concurrent subscriptions
    // trigger JWKS fetch, and subsequent ones build context before JWKS is cached.
    const contextFactoryMutex = new Mutex()

    // Create WebSocket handler for GraphQL subscriptions
    const websocketHandler = makeHandler<undefined, BunWebSocketExtra>({
      execute: (args: ExecutionArgs) => args.rootValue.execute(args),
      subscribe: (args: ExecutionArgs) => args.rootValue.subscribe(args),

      onConnect: (ctx) => {
        connectionCounter++
        connectionIdCounter++
        const connId = connectionIdCounter
        connectionToId.set(ctx, connId)

        // Store the WebSocket for later cleanup
        wsToContext.set(ctx.extra.socket, ctx)

        console.log(
          `\n🔌 [WS #${connId}] Connection OPENED (total active: ${connectionCounter})`,
        )
        console.log(`   Timestamp: ${new Date().toISOString()}`)

        // Update OpenTelemetry metric for active connections
        resolverRuntime.runFork(
          Metric.set(activeWebSocketConnections, connectionCounter),
        )

        return true
      },

      // Note: onDisconnect is not reliably called by graphql-ws when WebSocket closes
      // We handle cleanup manually in the WebSocket close handler below

      onComplete: (ctx, id) => {
        const sub = activeSubscriptions.get(id)
        const connId = connectionToId.get(ctx) ?? "?"
        if (sub) {
          const duration = Date.now() - sub.startTime.getTime()
          console.log(
            `✅ [WS #${connId}] Subscription COMPLETED: id=${id.slice(0, 8)} operation=${sub.operation} duration=${duration}ms`,
          )
          activeSubscriptions.delete(id)
        }
        console.log(`📊 [WS] Active subscriptions: ${activeSubscriptions.size}`)

        // Update OpenTelemetry metric for active subscriptions
        resolverRuntime.runFork(
          Metric.set(activeGraphqlSubscriptions, activeSubscriptions.size),
        )
      },

      onSubscribe: async (
        ctx: WsContext<undefined, BunWebSocketExtra>,
        id: string,
        payload: SubscribePayload,
      ) => {
        const connId = connectionToId.get(ctx) ?? 0
        activeSubscriptions.set(id, {
          operation: payload.operationName || "unknown",
          startTime: new Date(),
          connectionId: connId,
        })
        console.log(
          `\n📥 [WS #${connId}] New subscription: id=${id.slice(0, 8)} operation=${payload.operationName}`,
        )
        console.log(`   Timestamp: ${new Date().toISOString()}`)
        console.log(`📊 [WS] Active subscriptions: ${activeSubscriptions.size}`)

        // Update OpenTelemetry metric for active subscriptions
        resolverRuntime.runFork(
          Metric.set(activeGraphqlSubscriptions, activeSubscriptions.size),
        )

        const grouped = new Map<string, number>()
        for (const [, s] of activeSubscriptions) {
          grouped.set(s.operation, (grouped.get(s.operation) || 0) + 1)
        }
        console.log(
          "   By operation:",
          Array.from(grouped.entries())
            .map(([op, count]) => `${op}:${count}`)
            .join(", "),
        )
        try {
          // Get the original HTTP upgrade request for JWT validation
          const upgradeRequest = ctx.extra.socket.data.request

          const {
            schema,
            execute,
            subscribe,
            contextFactory,
            parse,
            validate,
          } = yoga.getEnveloped({
            ...ctx,
            // Explicitly pass connectionParams for JWT plugin extraction
            // (spreading ctx may not include it if it's a getter/non-enumerable)
            connectionParams: ctx.connectionParams,
            // Pass request for JWT plugin (it checks context.request)
            request: upgradeRequest,
            socket: ctx.extra.socket,
            params: payload,
          })

          // Serialize contextFactory calls to prevent JWKS fetch race condition.
          // Without this, multiple concurrent subscriptions may build context
          // before the JWKS cache is populated, resulting in missing JWT.
          const contextValue = await contextFactoryMutex.runExclusive(
            async () => contextFactory(),
          )

          const args = {
            schema,
            operationName: payload.operationName,
            document: parse(payload.query),
            variableValues: payload.variables,
            contextValue,
            rootValue: {
              execute,
              subscribe,
            },
          }

          const errors = validate(args.schema, args.document)
          if (errors.length) return errors
          return args
        } catch (error) {
          // Catch authentication and other errors from contextFactory
          // Return them as GraphQL errors array so they're properly handled by graphql-ws
          console.error(`[WS #${connId}] Subscription setup failed:`, error)
          if (error instanceof GraphQLError) {
            return [
              new GraphQLError(error.message, {
                extensions: error.extensions,
              }),
            ]
          }
          return [new GraphQLError("Unexpected error.")]
        }
      },
    })

    const serverOptions: Omit<
      Bun.Serve.Options<{ request: Request }>,
      "port"
    > = {
      fetch: async (
        request: Request,
        srv: Bun.Server<{ request: Request }>,
      ) => {
        const url = new URL(request.url)

        const webhookEffect = routeServerPluginWebhook(request)
        if (webhookEffect !== undefined) {
          return resolverRuntime.runPromise(webhookEffect)
        }

        // Handle internal callback endpoint for todo events
        if (
          url.pathname === "/internal/todo-event" &&
          request.method === "POST"
        ) {
          // Validate callback secret (required)
          const providedSecret = request.headers.get("x-callback-secret")

          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (
            !providedSecret ||
            !constantTimeEqual(providedSecret, callbackSecret.value)
          ) {
            return new Response("Unauthorized", { status: 401 })
          }

          const event = (await request.json()) as TodoChangeEvent

          // Get schema from yoga for emit call
          // Note: in local runtime, schema is unused but required by interface
          const { schema } = yoga.getEnveloped({ req: request })

          // Emit event to subscribers using Effect error handling
          const emitEffect = Effect.flatMap(TodoEvents, (todoEvents) =>
            todoEvents.emit(event, schema),
          )

          const result = await resolverRuntime.runPromiseExit(emitEffect)

          if (Exit.isFailure(result)) {
            console.error(
              "Failed to process todo event callback:",
              result.cause,
            )
            return new Response("Internal Server Error", { status: 500 })
          }

          return new Response(null, { status: 204 })
        }

        // Handle internal callback endpoint for process events
        if (
          url.pathname === "/internal/process-event" &&
          request.method === "POST"
        ) {
          // Validate callback secret (required)
          const providedSecret = request.headers.get("x-callback-secret")

          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (
            !providedSecret ||
            !constantTimeEqual(providedSecret, callbackSecret.value)
          ) {
            return new Response("Unauthorized", { status: 401 })
          }

          const event = (await request.json()) as ProcessChangeEvent

          // Get schema from yoga for emit call
          // Note: in local runtime, schema is unused but required by interface
          const { schema } = yoga.getEnveloped({ req: request })

          // Emit event to subscribers using Effect error handling
          const emitEffect = Effect.flatMap(ProcessEvents, (processEvents) =>
            processEvents.emit(event, schema),
          )

          const result = await resolverRuntime.runPromiseExit(emitEffect)

          if (Exit.isFailure(result)) {
            console.error(
              "Failed to process process event callback:",
              result.cause,
            )
            return new Response("Internal Server Error", { status: 500 })
          }

          return new Response(null, { status: 204 })
        }

        // Handle internal callback endpoint for execution events
        if (
          url.pathname === "/internal/execution-event" &&
          request.method === "POST"
        ) {
          // Validate callback secret (required)
          const providedSecret = request.headers.get("x-callback-secret")

          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (
            !providedSecret ||
            !constantTimeEqual(providedSecret, callbackSecret.value)
          ) {
            return new Response("Unauthorized", { status: 401 })
          }

          const event = (await request.json()) as ExecutionChangeEvent

          // Get schema from yoga for emit call
          // Note: in local runtime, schema is unused but required by interface
          const { schema } = yoga.getEnveloped({ req: request })

          // Emit event to subscribers using Effect error handling
          const emitEffect = Effect.flatMap(
            ExecutionEvents,
            (executionEvents) => executionEvents.emit(event, schema),
          )

          const result = await resolverRuntime.runPromiseExit(emitEffect)

          if (Exit.isFailure(result)) {
            console.error(
              "Failed to process execution event callback:",
              result.cause,
            )
            return new Response("Internal Server Error", { status: 500 })
          }

          return new Response(null, { status: 204 })
        }

        // Handle import-completed endpoint: notifies subscribers of process/execution/todo changes
        if (
          url.pathname === "/internal/import-completed" &&
          request.method === "POST"
        ) {
          // Validate callback secret (required)
          const providedSecret = request.headers.get("x-callback-secret")

          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (
            !providedSecret ||
            !constantTimeEqual(providedSecret, callbackSecret.value)
          ) {
            return new Response("Unauthorized", { status: 401 })
          }

          const ImportCompletedPayload = Schema.Struct({
            processPaths: Schema.Array(Schema.String),
          })

          let body: typeof ImportCompletedPayload.Type
          try {
            body = Schema.decodeUnknownSync(ImportCompletedPayload)(
              await request.json(),
            )
          } catch {
            return new Response("Invalid request body", { status: 400 })
          }
          const { processPaths } = body

          const { schema } = yoga.getEnveloped({ req: request })

          const importCompletedEffect = Effect.gen(function* () {
            yield* Effect.log(
              `Received import-completed for ${processPaths.length} process(es): ${processPaths.join(", ")}`,
            )
            const processOps = yield* ProcessCollectionOps
            const executionOps = yield* ExecutionCollectionOps
            const todoOps = yield* TodoCollectionOps
            const todoSummaryComputation = yield* TodoSummaryComputation

            // Pull all process documents and filter to matching paths
            const allProcessRows = yield* processOps.pull(null, 10000)
            const matchedProcessRows = allProcessRows.filter((row) =>
              processPaths.includes(row.path),
            )

            if (matchedProcessRows.length === 0) {
              yield* Effect.log(
                `No matching processes found (${allProcessRows.length} in DB, none matching requested paths)`,
              )
              return
            }

            // Map to GraphQL format and emit process events
            const graphqlProcesses = yield* Effect.all(
              matchedProcessRows.map((row) => processOps.mapToGraphql(row)),
              { concurrency: "unbounded" },
            )

            const lastProcess = graphqlProcesses[graphqlProcesses.length - 1]
            if (lastProcess) {
              const processEvent: ProcessChangeEvent = {
                documents: graphqlProcesses,
                checkpoint: {
                  id: lastProcess.id,
                  updatedAt: lastProcess.updatedAt,
                },
              }
              yield* Effect.flatMap(ProcessEvents, (processEvents) =>
                processEvents.emit(processEvent, schema),
              )
            }
            yield* Effect.log(
              `Emitted ${graphqlProcesses.length} process update(s)`,
            )

            // Collect matched process paths for filtering executions
            const matchedPaths = new Set(graphqlProcesses.map((p) => p.path))

            // Pull all execution documents and filter by matching process paths
            const allExecutionRows = yield* executionOps.pull(null, 10000)
            const matchedExecutionRows = allExecutionRows.filter((row) =>
              matchedPaths.has(row.execution.processPath),
            )

            if (matchedExecutionRows.length > 0) {
              const graphqlExecutions = yield* Effect.all(
                matchedExecutionRows.map((row) =>
                  executionOps.mapToGraphql(row).pipe(
                    Effect.map((document) => ({
                      ...document,
                      startedByEmail: row.execution.startedByEmail,
                      startedByRolePath: row.execution.startedByRolePath,
                    })),
                  ),
                ),
                { concurrency: "unbounded" },
              )
              const lastExecution =
                graphqlExecutions[graphqlExecutions.length - 1]
              if (lastExecution) {
                const executionEvent: ExecutionChangeEvent = {
                  documents: graphqlExecutions,
                  checkpoint: {
                    id: lastExecution.id,
                    updatedAt: lastExecution.updatedAt,
                  },
                }
                yield* Effect.flatMap(ExecutionEvents, (executionEvents) =>
                  executionEvents.emit(executionEvent, schema),
                )
              }
              yield* Effect.log(
                `Emitted ${graphqlExecutions.length} execution update(s)`,
              )
            }

            // Pull all todo documents and filter by matching execution IDs
            const matchedExecutionIds = new Set(
              matchedExecutionRows.map((row) => row.execution.id),
            )

            const allTodoRows = yield* todoOps.pull(null, 10000)
            const matchedTodoRows = allTodoRows.filter((row) =>
              matchedExecutionIds.has(row.processExecutionId),
            )

            if (matchedTodoRows.length > 0) {
              const matchedTodoRowsWithSummary =
                yield* todoSummaryComputation.enrichWithSummaries(
                  matchedTodoRows,
                )
              const graphqlTodos = yield* Effect.all(
                matchedTodoRowsWithSummary.map((row) =>
                  todoOps.mapToGraphql(row),
                ),
                { concurrency: "unbounded" },
              )
              const sortedTodos = [...graphqlTodos].sort((a, b) => {
                if (a.updatedAt !== b.updatedAt) {
                  return a.updatedAt - b.updatedAt
                }
                return a.id.localeCompare(b.id)
              })
              const lastTodo = sortedTodos[sortedTodos.length - 1]
              if (lastTodo) {
                const todoEvent: TodoChangeEvent = {
                  documents: graphqlTodos,
                  checkpoint: {
                    id: lastTodo.id,
                    updatedAt: lastTodo.updatedAt,
                    mode: PullCheckpointMode.Incremental,
                  },
                }
                yield* Effect.flatMap(TodoEvents, (todoEvents) =>
                  todoEvents.emit(todoEvent, schema),
                )
              }
              yield* Effect.log(`Emitted ${graphqlTodos.length} todo update(s)`)
            }
          })

          const result = await resolverRuntime.runPromiseExit(
            importCompletedEffect,
          )

          if (Exit.isFailure(result)) {
            await resolverRuntime.runPromise(
              Effect.logError("Failed to process import-completed").pipe(
                Effect.annotateLogs("cause", String(result.cause)),
              ),
            )
            return new Response("Internal Server Error", { status: 500 })
          }

          await resolverRuntime.runPromise(
            Effect.log("Import-completed processing done"),
          )
          return new Response(null, { status: 204 })
        }

        // CORS headers for /files/ routes (browser uploads are cross-origin)
        const fileCorsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        } as const

        // Handle CORS preflight for file routes
        if (
          url.pathname.startsWith("/files/") &&
          request.method === "OPTIONS"
        ) {
          return new Response(null, { status: 204, headers: fileCorsHeaders })
        }

        // Handle file upload (PUT /files/{storePrefix}/{fileId}?token=...&expires=...)
        if (url.pathname.startsWith("/files/") && request.method === "PUT") {
          const pathParts = url.pathname.slice("/files/".length).split("/")
          if (pathParts.length !== 2) {
            return new Response("Bad Request", { status: 400 })
          }
          const [storePrefix, fileId] = pathParts as [string, string]
          const token = url.searchParams.get("token")
          const expires = url.searchParams.get("expires")

          if (!storePrefix || !fileId || !token || !expires) {
            return new Response("Bad Request", { status: 400 })
          }

          // Check expiry
          const expiresNum = Number(expires)
          if (Number.isNaN(expiresNum) || Date.now() / 1000 > expiresNum) {
            return new Response("URL expired", { status: 403 })
          }

          // Validate HMAC token (message includes storePrefix)
          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          const expectedToken = generateLocalDocumentStoreToken(
            storePrefix,
            fileId,
            expires,
            callbackSecret.value,
          )
          if (!constantTimeEqual(token, expectedToken)) {
            return new Response("Unauthorized", { status: 401 })
          }

          // Validate file exists in DB and is pending
          const fileResult = await resolverRuntime.runPromiseExit(
            Effect.gen(function* () {
              const fileOps = yield* FileOperations
              return yield* fileOps.getFileWithStore(fileId)
            }),
          )

          if (Exit.isFailure(fileResult)) {
            console.error("File validation failed:", fileResult.cause)
            return new Response("Internal Server Error", {
              status: 500,
              headers: fileCorsHeaders,
            })
          }

          const fileRecord = fileResult.value
          if (!fileRecord) {
            return new Response("File not found", {
              status: 404,
              headers: fileCorsHeaders,
            })
          }

          if (!fileRecord.uploadPending) {
            return new Response("File already uploaded", {
              status: 409,
              headers: fileCorsHeaders,
            })
          }

          // Validate content-type against document store's accepted types
          const contentType =
            request.headers.get("content-type") ?? "application/octet-stream"
          if (
            fileRecord.acceptedTypes &&
            fileRecord.acceptedTypes.length > 0 &&
            !fileRecord.acceptedTypes.includes(contentType)
          ) {
            return new Response(
              `Content type '${contentType}' not accepted. Allowed: ${fileRecord.acceptedTypes.join(", ")}`,
              { status: 415, headers: fileCorsHeaders },
            )
          }

          // Use document store's size limit if set, otherwise fall back to global config
          const maxFileSize = fileRecord.sizeLimit ?? docStoreConfig.maxFileSize

          // Check Content-Length before reading the body
          const contentLength = request.headers.get("content-length")
          if (contentLength != null) {
            const declaredSize = Number(contentLength)
            if (declaredSize > maxFileSize) {
              return new Response(
                `File too large: ${declaredSize} bytes exceeds limit of ${maxFileSize} bytes`,
                { status: 413, headers: fileCorsHeaders },
              )
            }
          }

          // Ensure storage subdirectory exists
          const storeDir = join(docStoreConfig.storagePath, storePrefix)
          if (!existsSync(storeDir)) {
            mkdirSync(storeDir, { recursive: true })
          }

          // Stream file body to disk, enforcing size limit as we go
          const filePath = join(docStoreConfig.storagePath, storePrefix, fileId)

          const requestBody = request.body
          if (!requestBody) {
            return new Response("Empty request body", {
              status: 400,
              headers: fileCorsHeaders,
            })
          }

          let bytesWritten = 0
          const writer = Bun.file(filePath).writer()
          let limitExceeded = false
          try {
            for await (const chunk of requestBody) {
              bytesWritten += chunk.byteLength
              if (bytesWritten > maxFileSize) {
                limitExceeded = true
                break
              }
              writer.write(chunk)
            }
            await writer.end()
          } catch (writeError) {
            try {
              await writer.end()
            } catch {
              // Best-effort close
            }
            try {
              unlinkSync(filePath)
            } catch {
              // Best-effort cleanup
            }
            console.error(`Failed to write file ${fileId}:`, writeError)
            return new Response("Internal Server Error", {
              status: 500,
              headers: fileCorsHeaders,
            })
          }

          if (limitExceeded) {
            try {
              unlinkSync(filePath)
            } catch {
              // Best-effort cleanup
            }
            return new Response(
              `File too large: exceeds limit of ${maxFileSize} bytes`,
              { status: 413, headers: fileCorsHeaders },
            )
          }

          // Mark file as uploaded in DB (retry twice with backoff for transient errors)
          const markResult = await resolverRuntime.runPromiseExit(
            Effect.gen(function* () {
              const fileOps = yield* FileOperations
              yield* fileOps.markFileUploaded(fileId, bytesWritten, contentType)
            }).pipe(
              Effect.retry(
                Schedule.exponential("100 millis").pipe(
                  Schedule.compose(Schedule.recurs(2)),
                ),
              ),
            ),
          )
          if (Exit.isFailure(markResult)) {
            console.error(
              `Failed to mark file ${fileId} as uploaded in DB:`,
              markResult.cause,
            )
            // Remove orphaned file so client can retry cleanly
            try {
              unlinkSync(filePath)
            } catch {
              // Best-effort cleanup
            }
            return new Response("Internal Server Error", {
              status: 500,
              headers: fileCorsHeaders,
            })
          }

          console.log(
            `\n📤 File UPLOADED: id=${fileId.slice(0, 8)}… store=${storePrefix} size=${bytesWritten} bytes contentType=${contentType}`,
          )

          return new Response(null, {
            status: 204,
            headers: fileCorsHeaders,
          })
        }

        // Handle file download (GET /files/{storePrefix}/{fileId}?token=...&expires=...&filename=...)
        if (url.pathname.startsWith("/files/") && request.method === "GET") {
          const pathParts = url.pathname.slice("/files/".length).split("/")
          if (pathParts.length !== 2) {
            return new Response("Bad Request", { status: 400 })
          }
          const [storePrefix, fileId] = pathParts as [string, string]
          const token = url.searchParams.get("token")
          const expires = url.searchParams.get("expires")
          const filename = url.searchParams.get("filename")

          if (!storePrefix || !fileId || !token || !expires) {
            return new Response("Bad Request", { status: 400 })
          }

          // Check expiry
          const expiresNum = Number(expires)
          if (Number.isNaN(expiresNum) || Date.now() / 1000 > expiresNum) {
            return new Response("URL expired", { status: 403 })
          }

          if (filename && hasInvalidDownloadFilename(filename)) {
            return new Response("Bad Request", { status: 400 })
          }

          // Validate HMAC token (message includes storePrefix)
          if (Option.isNone(callbackSecret)) {
            return new Response("Unauthorized", { status: 401 })
          }
          const expectedToken = generateLocalDocumentStoreToken(
            storePrefix,
            fileId,
            expires,
            callbackSecret.value,
            filename ?? undefined,
          )
          if (!constantTimeEqual(token, expectedToken)) {
            return new Response("Unauthorized", { status: 401 })
          }

          const filePath = join(docStoreConfig.storagePath, storePrefix, fileId)
          if (!existsSync(filePath)) {
            console.log(
              `\n📥 File DOWNLOAD failed: id=${fileId.slice(0, 8)}… store=${storePrefix} — not found`,
            )
            return new Response("Not Found", { status: 404 })
          }

          const file = Bun.file(filePath)
          const responseHeaders: Record<string, string> = {
            ...fileCorsHeaders,
          }
          if (filename) {
            responseHeaders["Content-Disposition"] =
              formatContentDisposition(filename)
          }
          console.log(
            `\n📥 File DOWNLOADED: id=${fileId.slice(0, 8)}… store=${storePrefix} size=${file.size} bytes`,
          )
          return new Response(file, { headers: responseHeaders })
        }

        // Check if this is a WebSocket upgrade request
        const upgradeHeader = request.headers.get("upgrade")

        if (upgradeHeader === "websocket") {
          // Validate WebSocket subprotocol
          const protocol = request.headers.get("sec-websocket-protocol") || ""
          if (!handleProtocols(protocol)) {
            return new Response("Bad Request", { status: 400 })
          }

          // Attempt upgrade with request data for cookie access
          if (
            !srv.upgrade(request, {
              data: {
                request,
              },
            })
          ) {
            return new Response("Internal Server Error", { status: 500 })
          }

          return new Response()
        }

        // Otherwise handle as HTTP request via Yoga
        return yoga.fetch(request, srv)
      },
      websocket: {
        ...websocketHandler,
        open(ws) {
          const result = websocketHandler.open?.(ws)
          return result
        },
        close(ws, code, reason) {
          // Manually trigger cleanup since graphql-ws onDisconnect isn't being called
          const ctx = wsToContext.get(ws)
          if (ctx) {
            connectionCounter--
            const connId = connectionToId.get(ctx) ?? "?"
            console.log(
              `\n🔌 [WS #${connId}] Connection CLOSED: code=${code} reason=${reason} (remaining: ${connectionCounter})`,
            )
            console.log(`   Timestamp: ${new Date().toISOString()}`)

            // Update OpenTelemetry metric for active connections
            resolverRuntime.runFork(
              Metric.set(activeWebSocketConnections, connectionCounter),
            )

            // Clean up orphaned subscriptions from this connection
            const remaining = Array.from(activeSubscriptions.entries()).filter(
              ([, s]) => s.connectionId === connId,
            )
            if (remaining.length > 0) {
              console.log(
                "   🧹 Cleaning up orphaned subscriptions:",
                remaining
                  .map(([id, s]) => `${id.slice(0, 8)}:${s.operation}`)
                  .join(", "),
              )
              // Remove orphaned subscriptions
              for (const [id] of remaining) {
                activeSubscriptions.delete(id)
              }
              console.log(
                `📊 [WS] Active subscriptions: ${activeSubscriptions.size}`,
              )

              // Update OpenTelemetry metric for active subscriptions
              resolverRuntime.runFork(
                Metric.set(
                  activeGraphqlSubscriptions,
                  activeSubscriptions.size,
                ),
              )
            }
          }

          // Call graphql-ws close handler
          return websocketHandler.close?.(ws, code, reason)
        },
      },
    }

    // Start server - use exact port if specified (fails if in use), otherwise fallback
    type ServerError = PortInUseError | ServerStartError | NoAvailablePortError
    const serveEffect: Effect.Effect<
      import("../server-utils").TcpServer<{ request: Request }>,
      ServerError
    > = Option.isSome(port)
      ? serveOnExactPort<{ request: Request }>(port.value, serverOptions)
      : serveWithPortFallback<{ request: Request }>(
          DEFAULT_GRAPHQL_PORT,
          serverOptions,
        )

    const server = yield* Effect.acquireRelease(serveEffect, (srv) =>
      Effect.promise(() => srv.stop()),
    )

    yield* Effect.log(
      `🚀 GraphQL server running at http://${server.hostname}:${server.port}/graphql`,
    )
    yield* Effect.log(
      `🔌 WebSocket subscriptions available at ws://${server.hostname}:${server.port}/graphql`,
    )

    return server
  })
