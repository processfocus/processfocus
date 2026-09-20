import { parseArgs as utilParseArgs } from "node:util"
import * as Otel from "@effect/opentelemetry"
import {
  FetchHttpClient,
  type HttpApp,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Runtime as SharedRuntime } from "@processfocus/runtime"
import {
  Cause,
  Config,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  LogLevel,
  Logger,
  Option,
  Runtime,
  Schema,
} from "effect"
import {
  DelegationSessionServiceIsolated,
  buildFrontendClients,
  createAuthenticationServer,
} from "@pf/auth-api"
import {
  DatabaseConnectionInfo,
  LOCAL_SQLITE_BUSY_TIMEOUT_MS,
} from "@pf/db-info"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteDelegationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  removeExpiredOAuthStorage,
} from "@pf/sqlite-operations"
import {
  serveOnExactPort,
  serveWithPortFallback,
  writePortFile,
} from "../server-utils"
import { makeLocalSqlClientLayer } from "../services/local-sql-client-layer"
import { AuthenticationAuthorizationLive } from "./authorization"

// CLI argument parsing
class InvalidUsageError extends Data.TaggedError("InvalidUsageError")<{
  _: undefined
}> {}

const ParsedArgsSchema = Schema.Struct({
  port: Schema.optional(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 65535)),
  ),
})

type ParsedArgs = Schema.Schema.Type<typeof ParsedArgsSchema>

const parseArgs = (
  args: string[],
): Effect.Effect<ParsedArgs, InvalidUsageError> =>
  Effect.gen(function* () {
    const parseResult = yield* Effect.try({
      try: () =>
        utilParseArgs({
          args,
          options: {
            port: { type: "string", short: "p" },
          },
          strict: true,
          allowPositionals: false,
        }),
      catch: () => new InvalidUsageError({ _: undefined }),
    })

    return yield* Schema.decodeUnknown(ParsedArgsSchema)({
      port: parseResult.values.port,
    }).pipe(Effect.mapError(() => new InvalidUsageError({ _: undefined })))
  })

/**
 * CLI configuration service for the authentication server.
 */
interface CliConfig {
  /** Explicit port to use (strict mode - no fallback) */
  readonly port: Option.Option<number>
  /** First port to try when no explicit port was supplied */
  readonly basePort: number
  /** Enables dummy auth provider when Some */
  readonly bypassAuthEmail: Option.Option<string>
}

const CliConfig = Context.GenericTag<CliConfig>(
  "@pf/runtime-local/AuthServerCliConfig",
)

const resolveCliConfig = Effect.gen(function* () {
  const args = yield* parseArgs(process.argv.slice(2)).pipe(
    Effect.catchAll((error) => {
      console.error(
        "Invalid arguments. Usage: bun run authentication-server.ts [--port PORT | -p PORT]",
      )
      console.error(
        "  --port, -p       Exact port number (fails if port in use, does not write port file)",
      )
      console.error(
        "  Set PF_BYPASS_AUTH=<email> to use dummy provider, logging in as provider user with given email",
      )
      return Effect.fail(error)
    }),
  )

  const bypassAuth = yield* Config.option(Config.string("PF_BYPASS_AUTH"))
  const basePort = yield* Config.withDefault(Config.number("PORT"), 4020)

  if (Option.isSome(bypassAuth)) {
    yield* Effect.logWarning(
      `PF_BYPASS_AUTH is set — using dummy auth provider for ${bypassAuth.value}`,
    )
  }

  return {
    port: Option.fromNullable(args.port),
    basePort,
    bypassAuthEmail: bypassAuth,
  } satisfies CliConfig
})

// Use provideMerge to expose DatabaseConnectionInfo alongside other services
const DatabaseLayer = TypedSqliteDrizzleLayer.pipe(
  Layer.provideMerge(
    makeLocalSqlClientLayer({ busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS }),
  ),
)

const AuthenticationLayer = SqliteAuthenticationDatabaseLive.pipe(
  Layer.provideMerge(DatabaseLayer),
)

const StorageLayer = SqliteOpenAuthStorageServiceLive.pipe(
  Layer.provideMerge(AuthenticationLayer),
)

const AppLayer = DelegationSessionServiceIsolated.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      StorageLayer,
      SqliteDelegationDatabaseLive.pipe(Layer.provide(DatabaseLayer)),
      FetchHttpClient.layer,
      AuthenticationAuthorizationLive,
    ),
  ),
)

/**
 * OpenTelemetry NodeSdk layer for tracing authentication operations
 */
const NodeSdkLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const otlpMetricsUrl = yield* Config.string("OTLP_METRICS_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/metrics"),
    )
    const otlpTracesUrl = yield* Config.string("OTLP_TRACES_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/traces"),
    )

    return Otel.NodeSdk.layer(() => ({
      resource: { serviceName: "authentication-server" },
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: otlpMetricsUrl,
        }),
      }),
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: otlpTracesUrl,
        }),
      ),
    }))
  }),
)

/**
 * Create fetch handler that wraps requests with OpenTelemetry spans.
 * The span name `${method} ${pathname}` becomes the trace name.
 *
 * Runs the HTTP app directly as an Effect within the span so that
 * child spans (sql.transaction, auth.success, etc.) are properly connected.
 */
const createFetchHandler = (
  app: HttpApp.Default<never>,
  runtime: Runtime.Runtime<never>,
): ((req: Request) => Promise<Response>) => {
  const runPromise = Runtime.runPromise(runtime)
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    return runPromise(
      Effect.gen(function* () {
        // Run the HTTP app directly as an Effect (not via Promise)
        // so child spans are connected to this parent span
        const serverRequest = HttpServerRequest.fromWeb(req)
        const response = yield* app.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            serverRequest,
          ),
        )
        const webResponse = HttpServerResponse.toWeb(response, { runtime })
        yield* Effect.annotateCurrentSpan(
          "http.status_code",
          webResponse.status,
        )
        return webResponse
      }).pipe(
        Effect.withSpan(`${req.method} ${url.pathname}`, {
          attributes: {
            "http.method": req.method,
            "http.url": url.pathname,
          },
        }),
        Effect.catchAllCause(() =>
          Effect.logError("Unhandled auth server request failure").pipe(
            Effect.as(new Response("Internal Server Error", { status: 500 })),
          ),
        ),
      ),
    )
  }
}

const main = Effect.gen(function* () {
  const cliConfig = yield* CliConfig

  // Log database connection
  const dbConnectionInfo = yield* DatabaseConnectionInfo
  yield* Effect.log(`💾 Connecting to database: ${dbConnectionInfo}`)

  // Clean up expired OAuth tokens in background (log failures; do not block startup)
  yield* Effect.gen(function* () {
    const count = yield* removeExpiredOAuthStorage
    if (count > 0) {
      yield* Effect.log(`🧹 Removed ${count} expired OAuth token(s)`)
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("OAuth cleanup failed", cause),
    ),
    Effect.fork,
  )

  // Build frontend clients (with hashed secrets if configured)
  const frontendClients = yield* Effect.promise(buildFrontendClients)

  // Create the authentication server issuer
  // When PF_BYPASS_AUTH is set, use dummy provider for testing
  // Returns the app and a unified runtime with auth services + outer context (OTEL, etc.)
  const { app, runtime } = yield* createAuthenticationServer(
    Option.isSome(cliConfig.bypassAuthEmail)
      ? {
          dummyConfig: {
            email: cliConfig.bypassAuthEmail.value,
          },
          clients: frontendClients,
        }
      : { clients: frontendClients },
  )

  // Create fetch handler that runs the app with OpenTelemetry tracing
  // The unified runtime has both auth services and OTEL tracer
  const fetch = createFetchHandler(app, runtime)

  // Start the server - use exact port if specified (strict mode), otherwise fallback
  const server = yield* Option.match(cliConfig.port, {
    onSome: (port) =>
      serveOnExactPort(port, {
        fetch,
        development: false,
      }),
    onNone: () =>
      serveWithPortFallback(cliConfig.basePort, {
        fetch,
        development: false,
      }),
  })

  // Only write port file if not using explicit port (fallback mode)
  if (Option.isNone(cliConfig.port)) {
    yield* writePortFile(".auth-port.json", server.port)
  }

  yield* Effect.log(
    `🚀 Authentication server running at http://${server.hostname}:${server.port}`,
  )

  // Keep the Effect running to prevent layers from being finalized
  return yield* Effect.never
})

Effect.runPromiseExit(
  resolveCliConfig.pipe(
    Effect.flatMap((cliConfig) =>
      SharedRuntime.authentication({
        database: DatabaseLayer,
        configuration: Layer.succeed(CliConfig, cliConfig),
        policy: AppLayer,
        server: (services) =>
          main.pipe(
            Effect.provide(services),
            Effect.provideService(CliConfig, cliConfig),
          ),
        logging: {
          decorate: (effect) =>
            effect.pipe(
              Effect.provide(NodeSdkLive),
              Logger.withMinimumLogLevel(LogLevel.Debug),
              Effect.provide(Logger.pretty),
            ),
        },
      }),
    ),
  ),
).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(
      "Authentication server failed to start:",
      Cause.pretty(exit.cause, { renderErrorCause: true }),
    )
    process.exit(1)
  }
})
