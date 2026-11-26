import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as utilParseArgs } from "node:util"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { NodeFileSystem } from "@effect/platform-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type {
  EmailSender,
  NotificationDeliveryConfig,
} from "@processfocus/runtime"
import { makeServerPluginJobLayer } from "@processfocus/runtime"
import {
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  References,
  Schema,
  Semaphore,
} from "effect"
import { FetchHttpClient } from "effect/http"
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
import { getEffectiveFrontendBaseUrl } from "@pf/frontend-endpoints/port-files"
import {
  ExecutionCollectionOpsLive,
  ProcessCollectionOpsLive,
  SlaCalculationServiceLive,
  TodoCollectionOpsLive,
} from "@pf/graphql-api"
import {
  PROCESS_IMPORT_OUTBOX_QUEUE,
  UserDetails,
} from "@pf/graphql-db-operations"
import {
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  LoggingEmailSenderLive,
  NOTIFICATION_DELIVERY_QUEUE,
  PROCESS_EVENT_QUEUE,
  SYSTEM_STEP_EXECUTION_QUEUE,
  TODO_EVENT_QUEUE,
  executionEventHandler,
  flowExecutionHandler,
  makeNotificationDeliveryConfig,
  notificationDeliveryHandler,
  processEventHandler,
  systemStepExecutionHandler,
  todoEventHandler,
} from "@pf/job-handler"
import {
  ConditionEvaluator,
  ForEachItemsResolver,
  type Organisation,
  OrganisationProvider,
  OrganisationProviderFromPath,
  OrganisationProviderFromPathDev,
  ScheduleEvaluator,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeForEachItemsResolver,
  makeScheduleEvaluator,
  makeSystemStepExecutor,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import {
  SqliteCompletedJobOperationsLive,
  SqliteFileOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { warnIgnoredCronDeclarations } from "../cron-warnings"
import { LocalFileResolutionHostLive } from "../services/docker-file-resolver"
import { makeLocalExecutorHostLayer } from "../services/docker-step-runtime"
import { HttpExecutionFromJobPublisherLive } from "../services/http-execution-from-job-publisher"
import { HttpProcessFromJobPublisherLive } from "../services/http-process-from-job-publisher"
import { HttpTodoFromJobPublisherLive } from "../services/http-todo-from-job-publisher"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../services/local-document-store"
import { LocalQueueServiceLive } from "../services/local-queue-service"
import { makeLocalSqlClientLayer } from "../services/local-sql-client-layer"
import { GRAPHQL_PORT_FILE } from "../services/port-file"
import { createSingleQueuePoller } from "./queue-poller"
import { jobHandler } from "./types"
import { startWorkerHeartbeat } from "./worker-protocol"

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
    return Layer.provideMerge(LocalCedarAuthorizationLive, hotReloadConfig)
  }

  // No custom policies - use static default config (with optional custom schemas)
  const staticConfig = LocalCedarConfigStatic(undefined, schemaPaths)
  return Layer.provideMerge(LocalCedarAuthorizationLive, staticConfig)
}

// CLI argument parsing
class InvalidUsageError extends Data.TaggedError("InvalidUsageError")<{
  _: undefined
}> {}

const ParsedArgsSchema = Schema.Struct({
  org: Schema.String,
  check: Schema.Boolean,
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
            org: { type: "string", short: "o" },
            check: { type: "boolean", default: false },
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

    return yield* Schema.decodeUnknownEffect(ParsedArgsSchema)({
      org,
      check: parseResult.values.check,
    }).pipe(Effect.mapError(() => new InvalidUsageError({ _: undefined })))
  })

/**
 * CLI configuration service for the job worker.
 */
interface CliConfig {
  readonly org: string
  readonly check: boolean
}

const CliConfig = Context.Service<CliConfig>(
  "@pf/runtime-local/JobWorkerCliConfig",
)

/**
 * Layer that parses CLI arguments and provides CliConfig.
 */
const CliConfigLive = Layer.effect(
  CliConfig,
  parseArgs(process.argv.slice(2)).pipe(
    Effect.map((args) => ({
      org: args.org,
      check: args.check,
    })),
    Effect.catch((error) => {
      console.error(
        "Invalid arguments. Usage: bun run job-worker.ts [--org ORG | -o ORG] [--check]",
      )
      console.error("  --org, -o  Path to org project (or set PF_ORG env var)")
      return Effect.fail(error)
    }),
  ),
)

/**
 * OpenTelemetry NodeSdk layer for tracing and metrics in job worker operations.
 *
 * Exports traces to the default OTLP endpoint at http://127.0.0.1:4318/v1/traces
 * Exports metrics to the default OTLP endpoint at http://127.0.0.1:4318/v1/metrics
 */
const NodeSdkLive = NodeSdk.layer(() => ({
  resource: { serviceName: "job-worker" },
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      // Exports to default OTLP endpoint at http://127.0.0.1:4318/v1/metrics
    }),
  }),
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({
      // Exports to default OTLP endpoint at http://127.0.0.1:4318/v1/traces
    }),
  ),
}))

/**
 * Layer providing the RequestTime for database operations.
 *
 * The is initialized with a default value. Unlike the GraphQL server,
 * the job worker uses the current time for each job processing.
 */
const RequestTimeLive = Layer.succeed(RequestTime, DateTime.makeUnsafe(0))

/**
 * Layer providing the CurrentPrincipal for authorization checks.
 *
 * The is initialized with null since job workers have no user context.
 * Custom layers (e.g., OrgAuthorizationServiceLive) need this at construction time.
 */
const CurrentPrincipalLive = Layer.succeed(
  CurrentPrincipal,
  null as ProviderUserPrincipal | null,
)

/**
 * Layer providing the UserDetails for database operations.
 *
 * The is initialized with SYSTEM as the user since job workers
 * operate without user context.
 */
const UserDetailsLive = Layer.succeed(UserDetails, {
  by: "SYSTEM",
  id: null,
})

const DefaultNotificationDeliveryConfigLive = makeNotificationDeliveryConfig(
  () => getEffectiveFrontendBaseUrl(),
)

/**
 * Create the application layer with the loaded organisation.
 * This is called after the organisation is loaded at runtime.
 */
const createAppLayer = <E, R>(
  org: Organisation,
  orgProviderLayer: Layer.Layer<OrganisationProvider, E, R>,
  policyPaths: readonly string[],
  schemaPaths: readonly string[],
  orgPath: string,
) => {
  const ConditionEvaluatorLive = Layer.succeed(
    ConditionEvaluator,
    makeConditionEvaluator(org),
  )
  const ScheduleEvaluatorLive = Layer.succeed(
    ScheduleEvaluator,
    makeScheduleEvaluator(org),
  )
  const SystemStepExecutorLive = Layer.succeed(
    SystemStepExecutor,
    makeSystemStepExecutor(org),
  )
  const ForEachItemsResolverLive = Layer.succeed(
    ForEachItemsResolver,
    makeForEachItemsResolver(org),
  )

  const AuthorizationLive = makeAuthorizationLayer(policyPaths, schemaPaths)

  // Document store for server-side file resolution and attachment delivery.
  const internalApiSecret = process.env["INTERNAL_API_SECRET"] ?? "dev-secret"
  const DocumentStoreConfigLive = Layer.succeed(LocalDocumentStoreConfig, {
    baseUrl: () => "http://localhost:4000",
    storagePath: `${orgPath}/files`,
    secret: internalApiSecret,
    maxFileSize: 100 * 1024 * 1024,
  })
  const DocumentStoreLive = Layer.provide(
    LocalDocumentStoreServiceLive,
    DocumentStoreConfigLive,
  )
  const ExecutorHostLive = makeLocalExecutorHostLayer(orgPath)

  const TodoCollectionOpsWithDeps = Layer.provide(
    TodoCollectionOpsLive,
    SqliteGraphqlDbOperationsLive,
  )
  const ProcessCollectionOpsWithDeps = Layer.provide(
    ProcessCollectionOpsLive,
    SqliteGraphqlDbOperationsLive,
  )
  // SlaCalculationServiceLive needs SqliteGraphqlDbOperationsLive (for BusinessCalendarQueries)
  const SlaCalculationServiceWithDeps = SlaCalculationServiceLive.pipe(
    Layer.provide(SqliteGraphqlDbOperationsLive),
  )
  // ExecutionCollectionOpsLive needs SlaCalculationService, SqliteGraphqlDbOperationsLive, and OrganisationProvider
  const ExecutionCollectionOpsWithDeps = ExecutionCollectionOpsLive.pipe(
    Layer.provide(SlaCalculationServiceWithDeps),
    Layer.provide(SqliteGraphqlDbOperationsLive),
    Layer.provide(orgProviderLayer),
  )
  // TodoSummaryComputationLive needs SqliteGraphqlDbOperationsLive and OrganisationProvider
  const TodoSummaryComputationWithDeps = TodoSummaryComputationLive.pipe(
    Layer.provide(SqliteGraphqlDbOperationsLive),
    Layer.provide(orgProviderLayer),
  )

  const SqliteQueueWithRequestContext = LocalQueueServiceLive.pipe(
    Layer.provide(Layer.merge(RequestTimeLive, UserDetailsLive)),
  )

  return Layer.mergeAll(
    SqliteQueueWithRequestContext,
    SqliteFlowExecutionOperationsLive,
    SqliteScheduledFlowOperationsLive,
    SqliteCompletedJobOperationsLive,
    SqliteFileOperationsLive,
    SqliteGraphqlDbOperationsLive,
    ConditionEvaluatorLive,
    ScheduleEvaluatorLive,
    SystemStepExecutorLive,
    ForEachItemsResolverLive,
    DocumentStoreLive,
    LocalFileResolutionHostLive,
    ExecutorHostLive,
    RequestTimeLive,
    UserDetailsLive,
    CurrentPrincipalLive,
    AuthorizationLive,
    TodoCollectionOpsWithDeps,
    ProcessCollectionOpsWithDeps,
    ExecutionCollectionOpsWithDeps,
    TodoSummaryComputationWithDeps,
    // HttpTodoFromJobPublisherLive uses buildTodoChangeEvent, no collection ops needed
    HttpTodoFromJobPublisherLive,
    // Process/execution publishers need collection ops + UserDetails closed over at construction
    Layer.provide(
      HttpProcessFromJobPublisherLive,
      Layer.merge(ProcessCollectionOpsWithDeps, UserDetailsLive),
    ),
    Layer.provide(
      HttpExecutionFromJobPublisherLive,
      Layer.merge(ExecutionCollectionOpsWithDeps, UserDetailsLive),
    ),
  ).pipe(
    Layer.provideMerge(orgProviderLayer),
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(
      // Let SQLite wait on CI/local process contention instead of immediately
      // failing transient writer races.
      makeLocalSqlClientLayer({ busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS }),
    ),
    Layer.provideMerge(FetchHttpClient.layer),
  )
}

/**
 * Global concurrency limit for job processing across all queues
 *
 * For SQLite a value larger than 1 is highly problematic due to process-wide
 * write-lock contention.
 */
const GLOBAL_MAX_CONCURRENT = 1

/**
 * Port file for frontend discovery.
 * Imported dynamically to trigger bun --watch on changes.
 */
const FRONTEND_PORT_FILE = ".frontend-port.json"

/**
 * Gets the runtime state directory.
 */
const getRuntimeRoot = (): string =>
  process.env["PF_RUNTIME_ROOT"] ?? process.cwd()

// Dynamic import of port file to register it with bun --watch.
// When this file changes, bun --watch will restart the job worker.
const portFilePath = join(getRuntimeRoot(), GRAPHQL_PORT_FILE)
if (existsSync(portFilePath)) {
  import(portFilePath).catch(() => {
    // Ignore errors - file might not exist or be invalid
  })
}

const frontendPortFilePath = join(getRuntimeRoot(), FRONTEND_PORT_FILE)
if (existsSync(frontendPortFilePath)) {
  import(frontendPortFilePath).catch(() => {
    // Ignore errors - file might not exist or be invalid
  })
}

const queueHandlers = {
  [FLOW_EXECUTION_QUEUE]: jobHandler(flowExecutionHandler),
  [TODO_EVENT_QUEUE]: jobHandler(todoEventHandler),
  [PROCESS_EVENT_QUEUE]: jobHandler(processEventHandler),
  [PROCESS_IMPORT_OUTBOX_QUEUE]: jobHandler(processEventHandler),
  [EXECUTION_EVENT_QUEUE]: jobHandler(executionEventHandler),
  [SYSTEM_STEP_EXECUTION_QUEUE]: jobHandler(systemStepExecutionHandler),
  [NOTIFICATION_DELIVERY_QUEUE]: jobHandler(notificationDeliveryHandler),
}

const WorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.log("Starting job worker...")

    // Create a global semaphore shared by all queue pollers
    // This ensures only GLOBAL_MAX_CONCURRENT jobs run at once across all queues
    const globalSemaphore = yield* Semaphore.make(GLOBAL_MAX_CONCURRENT)

    const queueNames = Object.keys(queueHandlers).join(", ")

    yield* Effect.log(
      `Job worker started, polling ${queueNames} queues with a single dispatcher`,
    )

    // Run the dispatcher inline so initialization/policy failures end the layer
    // and reach supervision instead of leaving a healthy-looking idle worker.
    return yield* createSingleQueuePoller(queueHandlers, globalSemaphore)
  }),
)

/**
 * Build the full application layer with FileSystem provided.
 * Uses Dev variant which provides empty org on load failure (for bun --watch).
 */
const buildOrgProviderLayer = (orgPath: string) =>
  OrganisationProviderFromPathDev(orgPath).pipe(
    Layer.provide(NodeFileSystem.layer),
  )

const main = Effect.gen(function* () {
  const cliConfig = yield* CliConfig

  if (process.env["FRONTEND_BASE_URL"] === undefined) {
    process.env["FRONTEND_BASE_URL"] = getEffectiveFrontendBaseUrl()
  }

  const OrgProviderLayer = cliConfig.check
    ? OrganisationProviderFromPath(cliConfig.org).pipe(
        Layer.provide(NodeFileSystem.layer),
      )
    : buildOrgProviderLayer(cliConfig.org)

  const CedarPoliciesLayer = OrgCedarPoliciesProvider.pipe(
    Layer.provide(OrgProviderLayer),
  )

  const orgProvider = yield* OrganisationProvider.pipe(
    Effect.provide(OrgProviderLayer),
  )

  yield* warnIgnoredCronDeclarations(
    orgProvider.organisation,
    "local job worker",
  )

  yield* Effect.log(`✅ Loaded organisation: ${orgProvider.organisation.name}`)

  const cedarPolicies = yield* CedarPoliciesProvider.pipe(
    Effect.provide(CedarPoliciesLayer),
  )

  yield* Effect.log(
    `📜 Loaded ${cedarPolicies.policyPaths.length} Cedar policy files`,
  )

  const AppLayer = createAppLayer(
    orgProvider.organisation,
    OrgProviderLayer,
    cedarPolicies.policyPaths,
    cedarPolicies.schemaPaths,
    orgProvider.orgPath,
  )

  type AppServices = Layer.Success<typeof AppLayer>
  const customJobLayer = orgProvider.customJobLayer as
    | Layer.Layer<
        EmailSender | NotificationDeliveryConfig,
        unknown,
        AppServices
      >
    | undefined
  const serverPluginJobLayer = Layer.provide(
    makeServerPluginJobLayer(orgProvider.serverPlugins ?? []),
    AppLayer,
  ) as Layer.Layer<unknown, unknown, never>

  if (orgProvider.customDbLayer) {
    yield* Effect.log("🔌 Loaded custom database layer from organisation")
  }
  if (customJobLayer) {
    yield* Effect.log("✉️ Loaded custom job layer from organisation")
  }

  const notificationServicesLayer: Layer.Layer<
    EmailSender | NotificationDeliveryConfig,
    unknown,
    never
  > = customJobLayer
    ? Layer.provide(customJobLayer, Layer.merge(AppLayer, serverPluginJobLayer))
    : Layer.merge(LoggingEmailSenderLive, DefaultNotificationDeliveryConfigLive)

  const AppLayerWithNotificationServices = Layer.mergeAll(
    AppLayer,
    serverPluginJobLayer,
    notificationServicesLayer,
  )

  // Merge custom layer if present
  // Custom layers need SqlClient plus runtime-owned services.
  // OrgAuthorizationServiceLive needs AuthorizationService at construction time,
  // and CurrentPrincipal + RequestTime at runtime.
  const LocalSqlClientLive = makeLocalSqlClientLayer({
    busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS,
  })
  const customDbLayerDeps = Layer.mergeAll(
    SqliteFileOperationsLive,
    makeAuthorizationLayer(
      cedarPolicies.policyPaths,
      cedarPolicies.schemaPaths,
    ),
    CurrentPrincipalLive,
    RequestTimeLive,
  ).pipe(
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(LocalSqlClientLive),
  )
  type CustomDbLayerDependencies = Layer.Success<typeof customDbLayerDeps>
  const customDbLayer = orgProvider.customDbLayer as
    | Layer.Layer<unknown, unknown, CustomDbLayerDependencies>
    | undefined
  const customDbLayerWithDeps = customDbLayer
    ? (Layer.provide(customDbLayer, customDbLayerDeps) as Layer.Layer<
        unknown,
        never,
        never
      >)
    : undefined
  const AppLayerWithCustom = customDbLayerWithDeps
    ? Layer.merge(AppLayerWithNotificationServices, customDbLayerWithDeps)
    : AppLayerWithNotificationServices

  if (cliConfig.check) {
    // Validate the actual job dependencies, but never start queue consumers.
    // Close scoped resources before the long-running services are launched.
    yield* Layer.build(AppLayerWithCustom).pipe(Effect.scoped)
    yield* Effect.log("Job worker configuration check passed")
    return
  }

  const AppLive = WorkerLive.pipe(
    Layer.provide(AppLayerWithCustom),
  ) as Layer.Layer<never, unknown, never>

  return yield* Layer.launch(AppLive).pipe(Effect.provide(NodeSdkLive))
})

startWorkerHeartbeat()

const exit = await Effect.runPromiseExit(
  main.pipe(
    Effect.provide(CliConfigLive),
    Effect.tapCause((cause) =>
      Effect.logError(
        `Local runtime startup blocked: job worker initialization failed.\n${cause}\nFix the configuration above and restart the local runtime. Automatic process steps are unavailable.`,
      ),
    ),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(Logger.layer([Logger.consolePretty()])),
  ),
)
if (Exit.isFailure(exit)) process.exitCode = 1
