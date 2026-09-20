import {
  DiagLogLevel,
  type DiagLogger,
  context,
  diag,
  metrics,
  propagation,
  trace,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  ExportResultCode,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { otlpSignalUrls } from "@pf/aws-common"
import { SERVICE_NAME } from "./constants"
import { resolveOtlpConfig } from "./otlp-config"

/**
 * Register the global OTEL TracerProvider and MeterProvider.
 * Must be called once at server startup before any requests are handled.
 *
 * The global TracerProvider is picked up by:
 * - Next.js built-in tracing (page loads, route handling)
 * - @effect/opentelemetry's OtelTracer.layerGlobal (Effect.withSpan)
 */
// Module-level flag won't work across separately bundled chunks that each get
// their own copy. Use a globalThis sentinel instead so the guard survives
// chunk boundaries within the same process.
const OTEL_REGISTERED_KEY = "__pf_otel_registered__" as const
const METRIC_FAILURE_LOG_INTERVAL_MS = 60_000

export const readPfScopeFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const pfProject = env["PF_PROJECT"] ?? "unknown"
  const pfEnv = env["PF_ENV"] ?? "unknown"
  const pfScope = env["PF_SCOPE"] ?? `pf-${pfProject}-${pfEnv}`

  return {
    pfProject,
    pfEnv,
    pfScope,
  }
}

const createOtelDiagLogger = (): DiagLogger => ({
  error: (...args: unknown[]) => console.warn(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  info: (...args: unknown[]) => console.info(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  verbose: (...args: unknown[]) => console.debug(...args),
})

const formatExportError = (error?: Error) =>
  error ? `${error.name}: ${error.message}` : "unknown"

const createLoggingTraceExporter = (
  delegate: SpanExporter,
  options: {
    readonly tracesUrl: string
    readonly pfProject: string
    readonly pfEnv: string
    readonly pfScope: string
  },
): SpanExporter => {
  let loggedSuccess = false
  const forceFlush = delegate.forceFlush?.bind(delegate)

  return {
    export: (spans: ReadableSpan[], resultCallback) => {
      delegate.export(spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          if (!loggedSuccess) {
            loggedSuccess = true
            console.log(
              `[OTEL] Trace export succeeded: endpoint=${options.tracesUrl} pfProject=${options.pfProject} pfEnv=${options.pfEnv} pfScope=${options.pfScope} spanCount=${spans.length}`,
            )
          }
        } else {
          console.warn(
            `[OTEL] Trace export failed: endpoint=${options.tracesUrl} pfProject=${options.pfProject} pfEnv=${options.pfEnv} pfScope=${options.pfScope} spanCount=${spans.length} error=${formatExportError(result.error)}`,
          )
        }

        resultCallback(result)
      })
    },
    shutdown: () => delegate.shutdown(),
    ...(forceFlush && {
      forceFlush,
    }),
  }
}

const countMetricInstruments = (metrics: ResourceMetrics) =>
  metrics.scopeMetrics.reduce(
    (total, scopeMetrics) => total + scopeMetrics.metrics.length,
    0,
  )

const createLoggingMetricExporter = (
  delegate: PushMetricExporter,
  options: {
    readonly metricsUrl: string
    readonly pfProject: string
    readonly pfEnv: string
    readonly pfScope: string
  },
): PushMetricExporter => {
  let loggedSuccess = false
  let lastFailureLoggedAt = 0
  let suppressedFailureCount = 0

  return {
    export: (metrics: ResourceMetrics, resultCallback) => {
      const metricInstrumentCount = countMetricInstruments(metrics)

      delegate.export(metrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          lastFailureLoggedAt = 0
          suppressedFailureCount = 0
          if (!loggedSuccess) {
            loggedSuccess = true
            console.log(
              `[OTEL] Metric export succeeded: endpoint=${options.metricsUrl} pfProject=${options.pfProject} pfEnv=${options.pfEnv} pfScope=${options.pfScope} metricInstrumentCount=${metricInstrumentCount}`,
            )
          }
        } else {
          const now = Date.now()
          if (
            lastFailureLoggedAt === 0 ||
            now - lastFailureLoggedAt >= METRIC_FAILURE_LOG_INTERVAL_MS
          ) {
            const suppressedText =
              suppressedFailureCount > 0
                ? ` suppressedFailureCount=${suppressedFailureCount}`
                : ""
            console.error(
              `[OTEL] Metric export failed: endpoint=${options.metricsUrl} pfProject=${options.pfProject} pfEnv=${options.pfEnv} pfScope=${options.pfScope} metricInstrumentCount=${metricInstrumentCount} error=${formatExportError(result.error)}${suppressedText}`,
            )
            lastFailureLoggedAt = now
            suppressedFailureCount = 0
          } else {
            suppressedFailureCount += 1
          }
        }

        resultCallback(result)
      })
    },
    forceFlush: () => delegate.forceFlush(),
    shutdown: () => delegate.shutdown(),
    ...(delegate.selectAggregation && {
      selectAggregation: delegate.selectAggregation.bind(delegate),
    }),
    ...(delegate.selectAggregationTemporality && {
      selectAggregationTemporality:
        delegate.selectAggregationTemporality.bind(delegate),
    }),
  }
}

async function registerOtelOnce(): Promise<void> {
  const isLambda = !!process.env["AWS_LAMBDA_FUNCTION_NAME"]
  const config = isLambda ? await resolveOtlpConfig() : undefined
  const { pfProject, pfEnv, pfScope } = readPfScopeFromEnv()
  if (isLambda && !config) return
  const grafanaToken = isLambda ? undefined : process.env["GRAFANA_TOKEN"]
  const otlpEndpoint = isLambda ? undefined : process.env["OTLP_ENDPOINT"]

  // Enable OTEL diagnostic logging in Lambda so export errors are visible
  if (isLambda) {
    diag.setLogger(createOtelDiagLogger(), DiagLogLevel.WARN)
  }

  console.log(
    `[OTEL] Initializing: endpoint=${config?.tracesUrl ?? otlpEndpoint ?? "(local collector)"}, hasToken=${!!config || !!grafanaToken}, pfProject=${pfProject}, pfEnv=${pfEnv}, pfScope=${pfScope}`,
  )

  let tracesUrl: string
  let metricsUrl: string
  let headers: Record<string, string> | undefined

  if (config) {
    tracesUrl = config.tracesUrl
    metricsUrl = config.metricsUrl
    headers = config.headers
  } else if (otlpEndpoint) {
    ;({ tracesUrl, metricsUrl } = otlpSignalUrls(otlpEndpoint))
    if (grafanaToken) {
      headers = { Authorization: `Basic ${grafanaToken}` }
    }
  } else {
    // Local development — use local collector or custom URLs
    tracesUrl =
      process.env["OTLP_TRACES_URL"] ?? "http://localhost:4318/v1/traces"
    metricsUrl =
      process.env["OTLP_METRICS_URL"] ?? "http://localhost:4318/v1/metrics"
  }

  const resource = resourceFromAttributes({
    "service.name": SERVICE_NAME,
    "pf.project": pfProject,
    "pf.env": pfEnv,
    "pf.scope": pfScope,
  })

  const exporterConfig = headers
    ? { url: tracesUrl, headers }
    : { url: tracesUrl }

  const traceExporter = createLoggingTraceExporter(
    new OTLPTraceExporter(exporterConfig),
    {
      tracesUrl,
      pfProject,
      pfEnv,
      pfScope,
    },
  )

  // Keep OTLP export out of Next's render/prerender path. SimpleSpanProcessor
  // exports synchronously on span end, and the OTLP exporter touches timers and
  // current time, which Next 16 can treat as a prerender bailout and surface as
  // a 500. Losing a serverless span is better than failing the page render.
  const spanProcessor = new BatchSpanProcessor(
    traceExporter,
    isLambda
      ? {
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 5_000,
        }
      : undefined,
  )

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  })
  trace.setGlobalTracerProvider(tracerProvider)

  console.log(
    `[OTEL] TracerProvider registered: processor=Batch, tracesUrl=${tracesUrl}`,
  )

  // Enable context propagation for connecting spans across async boundaries
  const contextManager = new AsyncLocalStorageContextManager()
  contextManager.enable()
  context.setGlobalContextManager(contextManager)

  // Enable W3C trace context propagation for distributed tracing
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  const metricExporterConfig = headers
    ? { url: metricsUrl, headers }
    : { url: metricsUrl }

  const metricExporter = createLoggingMetricExporter(
    new OTLPMetricExporter(metricExporterConfig),
    {
      metricsUrl,
      pfProject,
      pfEnv,
      pfScope,
    },
  )

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 30000, // 30s for serverless/Lambda environments
      }),
    ],
  })
  metrics.setGlobalMeterProvider(meterProvider)

  console.log(
    `[OTEL] Fully initialized: traces=${tracesUrl}, metrics=${metricsUrl}`,
  )
}

export function registerOtel(): Promise<void> {
  const globals = globalThis as Record<string, unknown>
  const existingRegistration = globals[OTEL_REGISTERED_KEY]
  if (existingRegistration instanceof Promise) {
    return existingRegistration.then(() => undefined)
  }

  const registration = registerOtelOnce()
  globals[OTEL_REGISTERED_KEY] = registration
  return registration
}
