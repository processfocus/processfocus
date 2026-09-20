import * as Otel from "@effect/opentelemetry"
import { FetchHttpClient } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Runtime } from "@processfocus/runtime"
import {
  Cause,
  Config,
  Context,
  DateTime,
  Effect,
  Exit,
  FiberRef,
  Layer,
  LogLevel,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect"
import { DelegationSessionServiceIsolated } from "@pf/auth-api"
import {
  CedarPoliciesProvider,
  OrgCedarPoliciesProvider,
} from "@pf/auth-config"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import { CurrentPrincipal, type ProviderUserPrincipal } from "@pf/auth-policy"
import { LOCAL_SQLITE_BUSY_TIMEOUT_MS } from "@pf/db-info"
import {
  AppSchemaBuilderLive,
  AuthConfig,
  AuthConfigLive,
  BusinessMetricDimensions,
  DraftProcessExecutionCollectionOpsLive,
  DynamicSchemaConfig,
  ExecutionCollectionOpsLive,
  ListExportServiceLive,
  LocalDelegatedRealtime,
  ProcessCollectionOpsLive,
  ProcessDurationServiceLive,
  ResolverRuntime,
  SlaCalculationServiceLive,
  TodoCollectionOpsLive,
  YogaLive,
  makeDashboardActivityLayer,
  resolveBusinessMetricDimensions,
} from "@pf/graphql-api"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import {
  OrganisationProvider,
  OrganisationProviderFromPathDev,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteCompletedJobOperationsLive,
  SqliteDelegationDatabaseLive,
  SqliteFileOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { warnIgnoredCronDeclarations } from "../cron-warnings"
import { writePortFile } from "../server-utils"
import { DraftProcessEventsLive } from "../services/draft-process-events"
import { ExecutionEventsLive } from "../services/execution-events"
import { HttpCedarReloadNotifierLive } from "../services/http-cedar-reload-notifier"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../services/local-document-store"
import { makeLocalSqlClientLayer } from "../services/local-sql-client-layer"
import { DEFAULT_GRAPHQL_PORT, GRAPHQL_PORT_FILE } from "../services/port-file"
import { ProcessEventsLive } from "../services/process-events"
import { TodoEventsLive } from "../services/todo-events"
import {
  CallbackSecretLive,
  makeServerEffect,
  parseArgs,
} from "./graphql-internal-server"

/**
 * Create the authorization layer based on CedarPoliciesProvider configuration.
 * If the org has custom policies via PoliciesConfig, sets up file watching for hot reload.
 * Otherwise uses the default policies.
 */
const makeAuthorizationLayer = (
  policyPaths: readonly string[],
  schemaPaths: readonly string[],
) => {
  if (policyPaths.length > 0) {
    // Use hot reload config - watches custom policies and merges with defaults
    // Pass "/" as basePath since paths are already absolute
    const hotReloadConfig = LocalCedarConfigHotReload(
      "/",
      policyPaths,
      schemaPaths,
    )
    return Layer.provideMerge(LocalCedarAuthorizationLive, hotReloadConfig)
  }

  // No custom policies - use static default config (with optional custom schemas)
  const staticConfig = LocalCedarConfigStatic(undefined, schemaPaths)
  return Layer.provideMerge(LocalCedarAuthorizationLive, staticConfig)
}

/**
 * CLI configuration service for local development.
 * Captures command-line arguments at startup.
 */
interface CliConfig {
  /** Explicit port to use (strict mode - no fallback). None means use default with fallback */
  readonly port: Option.Option<number>
  readonly org: string
}

const CliConfig = Context.GenericTag<CliConfig>(
  "@pf/runtime-local/GraphqlServerCliConfig",
)

/**
 * Layer that parses CLI arguments and provides CliConfig.
 */
const CliConfigLive = Layer.effect(
  CliConfig,
  parseArgs(process.argv.slice(2)).pipe(
    Effect.map((args) => ({
      port: Option.fromNullable(args.port),
      org: args.org,
    })),
    Effect.catchAll((error) => {
      console.error(
        "Invalid arguments. Usage: bun run main.ts [--port PORT | -p PORT] [--org ORG | -o ORG]",
      )
      console.error(
        "  --port, -p  Exact port number (fails if in use, does not write port file)",
      )
      console.error("  --org, -o   Path to org project (or set PF_ORG env var)")
      return Effect.fail(error)
    }),
  ),
)

/**
 * Layer providing the RequestTime FiberRef for database operations.
 *
 * The FiberRef is initialized with a default value and updated at the start of
 * each GraphQL request in executeWithSpan. All resolver effects inherit the
 * per-request timestamp via fiber inheritance.
 */
const RequestTimeLive = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(DateTime.unsafeMake(0)),
)

/**
 * Layer providing the UserDetails FiberRef for database operations.
 *
 * The FiberRef is initialized with a default value and updated at the start of
 * each GraphQL request. All resolver effects inherit the per-request user
 * details via fiber inheritance.
 */
const UserDetailsLive = Layer.succeed(
  UserDetails,
  FiberRef.unsafeMake({
    by: "SYSTEM",
    id: null,
  }) as FiberRef.FiberRef<UserDetailsValue>,
)

/**
 * Layer providing the CurrentPrincipal FiberRef for authorization checks.
 *
 * The FiberRef is initialized with null and updated per-request in wrapResolver.
 * Cloud/org code can read the current principal without needing context.
 */
const CurrentPrincipalLive = Layer.succeed(
  CurrentPrincipal,
  FiberRef.unsafeMake(null as ProviderUserPrincipal | null),
)

/**
 * OpenTelemetry NodeSdk layer for tracing GraphQL operations
 */
const businessMetricDimensions = resolveBusinessMetricDimensions({
  accountId: process.env["PF_AWS_ACCOUNT_ID"],
  project: process.env["PF_PROJECT"],
  environment: process.env["PF_ENV"],
})

const BusinessMetricDimensionsLive = Layer.succeed(
  BusinessMetricDimensions,
  businessMetricDimensions,
)

const DashboardActivityLive = process.env["PF_ANALYTICS_IDENTITY_KEY"]
  ? makeDashboardActivityLayer({
      dimensions: businessMetricDimensions,
      key: Redacted.make(process.env["PF_ANALYTICS_IDENTITY_KEY"] ?? ""),
      logsUrl: process.env["OTLP_LOGS_URL"] ?? "http://127.0.0.1:4318/v1/logs",
      headers: {},
    })
  : Layer.empty

const NodeSdkLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const otlpMetricsUrl = yield* Config.string("OTLP_METRICS_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/metrics"),
    )
    const otlpTracesUrl = yield* Config.string("OTLP_TRACES_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/traces"),
    )

    return Otel.NodeSdk.layer(() => ({
      resource: {
        serviceName: "graphql-server",
        attributes: {
          "pf.account.id": businessMetricDimensions.accountId,
          "pf.account.name": businessMetricDimensions.accountName,
          "pf.account.scope": businessMetricDimensions.accountScope,
          "pf.project": businessMetricDimensions.project,
          "pf.env": businessMetricDimensions.environment,
        },
      },
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
 * Main application setup - loads org dynamically and creates all layers
 */
const main = Effect.gen(function* () {
  const cliConfig = yield* CliConfig

  // Memoize the OrganisationProvider layer to ensure single instantiation.
  // Without memoization, each Layer.provide/Effect.provide creates a new instance,
  // which can cause Cedar WASM initialization issues when multiple parses happen
  // in rapid succession before the module is fully loaded.
  // Uses Dev variant which provides empty org on load failure (for bun --watch).
  const OrgProviderLayer = yield* Layer.memoize(
    OrganisationProviderFromPathDev(cliConfig.org).pipe(
      Layer.provide(NodeFileSystem.layer),
    ),
  )

  // Create CedarPoliciesProvider layer that depends on OrganisationProvider
  const CedarPoliciesLayer = OrgCedarPoliciesProvider.pipe(
    Layer.provide(OrgProviderLayer),
  )

  // Get organisation provider service to build authorization layer
  const orgProvider = yield* OrganisationProvider.pipe(
    Effect.provide(OrgProviderLayer),
  )

  yield* warnIgnoredCronDeclarations(
    orgProvider.organisation,
    "local GraphQL runtime",
  )

  yield* Effect.log(`✅ Loaded organisation: ${orgProvider.organisation.name}`)
  if (orgProvider.customDbLayer) {
    yield* Effect.log(`📦 Custom database layer available from organisation`)
  }

  // Get cedar policies provider to get policy paths
  const cedarPolicies = yield* CedarPoliciesProvider.pipe(
    Effect.provide(CedarPoliciesLayer),
  )

  yield* Effect.log(
    `📜 Loaded ${cedarPolicies.policyPaths.length} Cedar policy files`,
  )

  // Create layer for dynamic schema configuration using provider's schema path
  const DynamicSchemaConfigLive = Layer.succeed(DynamicSchemaConfig, {
    schemaPath: orgProvider.schemaPath,
  })

  // Create layer for local document store configuration.
  // baseUrl is a function because the actual server port is only known after
  // `serveWithPortFallback` picks an available port.  The variable is
  // mutated in the ServerLive layer once the server is up.
  const internalApiSecret = process.env["INTERNAL_API_SECRET"] ?? "dev-secret"
  let resolvedServerPort = Option.isSome(cliConfig.port)
    ? cliConfig.port.value
    : DEFAULT_GRAPHQL_PORT
  const LocalDocumentStoreConfigLive = Layer.succeed(LocalDocumentStoreConfig, {
    baseUrl: () => `http://localhost:${resolvedServerPort}`,
    storagePath: `${orgProvider.orgPath}/files`,
    secret: internalApiSecret,
    maxFileSize: 100 * 1024 * 1024,
  })

  // Create authorization layer using cedar policy paths and schema paths
  const AuthorizationLive = makeAuthorizationLayer(
    cedarPolicies.policyPaths,
    cedarPolicies.schemaPaths,
  )

  // TodoSummaryComputationLive needs SqliteGraphqlDbOperationsLive and OrganisationProvider
  const TodoSummaryComputationWithDeps = TodoSummaryComputationLive.pipe(
    Layer.provide(SqliteGraphqlDbOperationsLive),
    Layer.provide(OrgProviderLayer),
  )

  // SlaCalculationServiceLive needs SqliteGraphqlDbOperationsLive (for BusinessCalendarQueries)
  const SlaCalculationServiceWithDeps = SlaCalculationServiceLive.pipe(
    Layer.provide(SqliteGraphqlDbOperationsLive),
  )

  // ExecutionCollectionOpsLive needs both SlaCalculationService and SqliteGraphqlDbOperationsLive
  const ExecutionCollectionOpsWithDeps = ExecutionCollectionOpsLive.pipe(
    Layer.provide(SlaCalculationServiceWithDeps),
    Layer.provide(SqliteGraphqlDbOperationsLive),
  )

  // ListExportServiceLive depends on DocumentStoreService and AuthorizationService
  const ListExportServiceWithDeps = ListExportServiceLive.pipe(
    Layer.provide(LocalDocumentStoreServiceLive),
    Layer.provide(LocalDocumentStoreConfigLive),
    Layer.provide(AuthorizationLive),
  )
  // Merge all layers into a single application layer
  // CustomDbLayer from org needs SqlClient plus runtime-owned services.
  // Type assertion needed because CustomDbLayer is typed as Layer<unknown, unknown, unknown>
  // but at runtime is properly constructed with only these requirements.
  const LocalSqlClientLive = makeLocalSqlClientLayer({
    busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS,
  })
  const customDbLayerDeps = Layer.mergeAll(
    SqliteFileOperationsLive,
    AuthorizationLive,
    CurrentPrincipalLive,
    BusinessMetricDimensionsLive,
    DashboardActivityLive,
    RequestTimeLive,
  ).pipe(
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(LocalSqlClientLive),
  )
  const customDbLayerWithDeps = orgProvider.customDbLayer
    ? (Layer.provide(
        orgProvider.customDbLayer,
        customDbLayerDeps,
      ) as Layer.Layer<unknown, never, never>)
    : undefined

  // HttpCedarReloadNotifierLive requires HttpClient, so we provide it first
  const HttpCedarReloadNotifierWithDeps = HttpCedarReloadNotifierLive.pipe(
    Layer.provide(FetchHttpClient.layer),
  )
  const SqliteQueueWithRequestContext = SqliteQueueServiceLive.pipe(
    Layer.provide(Layer.merge(RequestTimeLive, UserDetailsLive)),
  )

  const AppLayer = Layer.mergeAll(
    DelegationSessionServiceIsolated.pipe(
      Layer.provide(
        Layer.mergeAll(
          SqliteAuthenticationDatabaseLive,
          SqliteDelegationDatabaseLive,
        ),
      ),
      Layer.provide(AuthorizationLive),
    ),
    SqliteGraphqlDbOperationsLive,
    SqliteFileOperationsLive,
    SqliteFlowExecutionOperationsLive,
    SqliteCompletedJobOperationsLive,
    SqliteScheduledFlowOperationsLive,
    SqliteQueueWithRequestContext,
    DynamicSchemaConfigLive,
    Layer.provide(LocalDocumentStoreServiceLive, LocalDocumentStoreConfigLive),
    LocalDocumentStoreConfigLive,
    ListExportServiceWithDeps,
    DraftProcessEventsLive,
    TodoEventsLive,
    ProcessEventsLive,
    ExecutionEventsLive,
    RequestTimeLive,
    UserDetailsLive,
    CurrentPrincipalLive,
    BusinessMetricDimensionsLive,
    DashboardActivityLive,
    AuthorizationLive,
    TodoSummaryComputationWithDeps,
    SlaCalculationServiceWithDeps,
    HttpCedarReloadNotifierWithDeps,
    Layer.provide(
      DraftProcessExecutionCollectionOpsLive,
      SqliteGraphqlDbOperationsLive,
    ),
    Layer.provide(ProcessCollectionOpsLive, SqliteGraphqlDbOperationsLive),
    Layer.provide(ProcessDurationServiceLive, SqliteGraphqlDbOperationsLive),
    Layer.provide(TodoCollectionOpsLive, SqliteGraphqlDbOperationsLive),
    ExecutionCollectionOpsWithDeps,
    // Include custom db layer if available (provides services like SchoolOperations)
    ...(customDbLayerWithDeps ? [customDbLayerWithDeps] : []),
  ).pipe(
    Layer.provideMerge(OrgProviderLayer),
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(LocalSqlClientLive),
    Layer.provideMerge(FetchHttpClient.layer),
  )

  // Server layer
  const ServerLive = Layer.scopedDiscard(
    Effect.gen(function* () {
      const authConfig = yield* AuthConfig
      yield* Effect.log(`🔐 Authentication server: ${authConfig.issuerUrl}`)
      const server = yield* makeServerEffect(cliConfig.port)
      // Update the resolved port so document store URLs use the correct address
      resolvedServerPort = server.port
      // Only write port file if not using explicit port (fallback mode)
      if (Option.isNone(cliConfig.port)) {
        yield* writePortFile(GRAPHQL_PORT_FILE, server.port)
      }
      return yield* Effect.never
    }),
  )

  const QueueCapabilityLive = SqliteQueueWithRequestContext.pipe(
    Layer.provide(AppLayer),
  )
  const DocumentStoreCapabilityLive = LocalDocumentStoreServiceLive.pipe(
    Layer.provide(LocalDocumentStoreConfigLive),
  )
  const EventPublisherCapabilityLive = Layer.mergeAll(
    DraftProcessEventsLive,
    TodoEventsLive,
    ProcessEventsLive,
    ExecutionEventsLive,
  ).pipe(Layer.provide(AppLayer))

  return yield* Runtime.graphql({
    persistence: AppLayer,
    queue: QueueCapabilityLive,
    documentStore: DocumentStoreCapabilityLive,
    eventPublisher: EventPublisherCapabilityLive,
    organisationLoader: OrgProviderLayer,
    authorization: AuthorizationLive,
    transport: (services) => {
      const CapabilityLayer = Layer.effectContext(Effect.succeed(services))
      const ResolverRuntimeLive = Layer.effect(
        ResolverRuntime,
        Effect.sync(() =>
          ManagedRuntime.make(
            Layer.merge(CapabilityLayer, LocalDelegatedRealtime.layer).pipe(
              Layer.provide(NodeSdkLive),
            ),
          ),
        ),
      )
      const AppLive = ServerLive.pipe(
        Layer.provide(YogaLive),
        Layer.provide(AppSchemaBuilderLive),
        Layer.provide(ResolverRuntimeLive),
        Layer.provide(AuthConfigLive),
        Layer.provide(CallbackSecretLive),
        Layer.provide(CapabilityLayer),
      )
      return Layer.launch(AppLive)
    },
    logging: {
      decorate: (effect) =>
        effect.pipe(
          Logger.withMinimumLogLevel(LogLevel.Debug),
          Effect.provide(Logger.pretty),
        ),
    },
  })
})

// Run the main effect (scoped to provide Scope for Layer.memoize)
Effect.runPromiseExit(
  main.pipe(Effect.scoped, Effect.provide(CliConfigLive)),
).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(
      "GraphQL server failed to start:",
      Cause.pretty(exit.cause, { renderErrorCause: true }),
    )
    process.exit(1)
  }
})
