import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
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
  FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  References,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { AuthenticationDelegationIdentityFactsLive } from "@pf/auth-api/issuer"
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
import { DelegationSessionServiceIsolated } from "@pf/delegation/authorization"
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
import { UserDetails } from "@pf/graphql-db-operations"
import {
  OrganisationProvider,
  OrganisationProviderFromPath,
  OrganisationProviderFromPathDev,
  normalizePath,
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
  SqliteMcpOAuthRecordsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { warnIgnoredCronDeclarations } from "../cron-warnings"
import { writePortFile } from "../server-utils"
import { LocalRuntimeAuditLive } from "../services/audit"
import { DraftProcessEventsLive } from "../services/draft-process-events"
import { ExecutionEventsLive } from "../services/execution-events"
import { HttpCedarReloadNotifierLive } from "../services/http-cedar-reload-notifier"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../services/local-document-store"
import { LocalQueueServiceLive } from "../services/local-queue-service"
import { makeLocalSqlClientLayer } from "../services/local-sql-client-layer"
import { LocalPolicyRevisionPublisherLive } from "../services/policy-revision"
import { DEFAULT_GRAPHQL_PORT, GRAPHQL_PORT_FILE } from "../services/port-file"
import { ProcessEventsLive } from "../services/process-events"
import { ProjectAccountingEventsLive } from "../services/project-accounting-events"
import { TodoEventsLive } from "../services/todo-events"
import {
  CallbackSecretLive,
  makeServerEffect,
  parseArgs,
} from "./graphql-internal-server"

// This entrypoint also runs directly, without the local runtime supervisor.
process.env["PF_RUNTIME_MODE"] = "local"

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
    return LocalCedarAuthorizationLive.pipe(
      Layer.provide(LocalPolicyRevisionPublisherLive),
      Layer.provideMerge(hotReloadConfig),
    )
  }

  // No custom policies - use static default config (with optional custom schemas)
  const staticConfig = LocalCedarConfigStatic(undefined, schemaPaths)
  return LocalCedarAuthorizationLive.pipe(
    Layer.provide(LocalPolicyRevisionPublisherLive),
    Layer.provideMerge(staticConfig),
  )
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

const CliConfig = Context.Service<CliConfig>(
  "@pf/runtime-local/GraphqlServerCliConfig",
)

/**
 * Layer that parses CLI arguments and provides CliConfig.
 */
const CliConfigLive = Layer.effect(
  CliConfig,
  parseArgs(process.argv.slice(2)).pipe(
    Effect.map((args) => ({
      port: Option.fromNullishOr(args.port),
      org: args.org,
    })),
    Effect.catch((error) => {
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
 * Layer providing the RequestTime for database operations.
 *
 * The is initialized with a default value and updated at the start of
 * each GraphQL request in executeWithSpan. All resolver effects inherit the
 * per-request timestamp via fiber inheritance.
 */
const RequestTimeLive = Layer.succeed(RequestTime, DateTime.makeUnsafe(0))

/**
 * Layer providing the UserDetails for database operations.
 *
 * The is initialized with a default value and updated at the start of
 * each GraphQL request. All resolver effects inherit the per-request user
 * details via fiber inheritance.
 */
const UserDetailsLive = Layer.succeed(UserDetails, {
  by: "SYSTEM",
  id: null,
})

/**
 * Layer providing the CurrentPrincipal for authorization checks.
 *
 * The is initialized with null and updated per-request in wrapResolver.
 * Cloud/org code can read the current principal without needing context.
 */
const CurrentPrincipalLive = Layer.succeed(
  CurrentPrincipal,
  null as ProviderUserPrincipal | null,
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

const NodeSdkLive = Layer.unwrap(
  Effect.gen(function* () {
    const otlpMetricsUrl = yield* Config.String("OTLP_METRICS_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/metrics"),
    )
    const otlpTracesUrl = yield* Config.String("OTLP_TRACES_URL").pipe(
      Config.withDefault("http://127.0.0.1:4318/v1/traces"),
    )

    return NodeSdk.layer(() => ({
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
  // A published slot must load successfully before signalling readiness.
  // Only direct source watching falls back to an empty organisation on failure.
  const importDir =
    process.env["PF_LOCAL_GRAPHQL_IMPORT"] === "1"
      ? resolve(cliConfig.org, ".processfocus/local-graphql")
      : undefined
  const OrgProviderLayer = (
    importDir
      ? Layer.effect(
          OrganisationProvider,
          Effect.gen(function* () {
            // Import (rather than read) the pointer so bun --watch restarts on publication.
            const slot: unknown = (yield* Effect.promise(
              () => import(join(importDir, "active.json")),
            )).default
            if (slot !== "a" && slot !== "b")
              return yield* Effect.fail(
                new Error("Invalid local GraphQL import slot"),
              )
            const loaded = yield* OrganisationProvider.pipe(
              Effect.provide(
                OrganisationProviderFromPath(join(importDir, slot)),
              ),
            )
            // Policies, documents and other project-relative resources still belong to the source org.
            return { ...loaded, orgPath: resolve(cliConfig.org) }
          }),
        )
      : OrganisationProviderFromPathDev(cliConfig.org)
  ).pipe(Layer.provide(NodeFileSystem.layer))

  const CedarPoliciesLayer = OrgCedarPoliciesProvider.pipe(
    Layer.provide(OrgProviderLayer),
  )

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

  const cedarPolicies = yield* CedarPoliciesProvider.pipe(
    Effect.provide(CedarPoliciesLayer),
  )

  yield* Effect.log(
    `📜 Loaded ${cedarPolicies.policyPaths.length} Cedar policy files`,
  )

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
  const SqliteQueueWithRequestContext = LocalQueueServiceLive.pipe(
    Layer.provide(Layer.merge(RequestTimeLive, UserDetailsLive)),
  )

  const AppLayer = Layer.mergeAll(
    LocalRuntimeAuditLive,
    AuthenticationDelegationIdentityFactsLive.pipe(
      Layer.provideMerge(SqliteAuthenticationDatabaseLive),
    ),
    DelegationSessionServiceIsolated.pipe(
      Layer.provide(
        Layer.mergeAll(
          AuthenticationDelegationIdentityFactsLive.pipe(
            Layer.provide(SqliteAuthenticationDatabaseLive),
          ),
          SqliteDelegationDatabaseLive,
        ),
      ),
      Layer.provide(AuthorizationLive),
    ),
    SqliteGraphqlDbOperationsLive,
    SqliteMcpOAuthRecordsLive,
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
    ProjectAccountingEventsLive.pipe(
      Layer.provide(SqliteQueueWithRequestContext),
    ),
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

  const ServerLive = Layer.effectDiscard(
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
      if (importDir) {
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(NodeFileSystem.layer),
        )
        const ready = join(importDir, "ready.json")
        yield* fs.writeFileString(
          `${ready}.tmp`,
          JSON.stringify({
            revision: randomUUID(),
            processPaths: orgProvider.organisation
              .processes()
              .map((p) => normalizePath(p.node.path)),
          }),
        )
        yield* fs.rename(`${ready}.tmp`, ready)
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
    ProjectAccountingEventsLive.pipe(
      Layer.provide(SqliteQueueWithRequestContext),
    ),
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
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([Logger.consolePretty()])),
        ),
    },
  })
})

// Run the main effect (scoped to provide Scope for Layer.memoize)
Effect.runPromiseExit(
  main.pipe(Effect.scoped, Effect.provide(CliConfigLive)),
).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error("GraphQL server failed to start:", Cause.pretty(exit.cause))
    process.exit(1)
  }
})
