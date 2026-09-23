import type { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import {
  type DataPoint,
  DataPointType,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics"
import { Schema } from "effect"

export const businessMetricsOtlpUrl =
  process.env["PF_BUSINESS_METRICS_OTLP_URL"] ?? null
export const businessMetricsPrometheusUrl =
  process.env["PF_BUSINESS_METRICS_PROMETHEUS_URL"] ?? null

const PrometheusVectorResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    resultType: Schema.Literal("vector"),
    result: Schema.Array(
      Schema.Struct({
        metric: Schema.Record({ key: Schema.String, value: Schema.String }),
        value: Schema.Tuple(Schema.Unknown, Schema.String),
      }),
    ),
  }),
})
type PrometheusVectorResult =
  (typeof PrometheusVectorResponse.Type)["data"]["result"]

const PrometheusMatrixResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    resultType: Schema.Literal("matrix"),
    result: Schema.Array(
      Schema.Struct({
        metric: Schema.Record({ key: Schema.String, value: Schema.String }),
        values: Schema.Array(Schema.Tuple(Schema.Number, Schema.String)),
      }),
    ),
  }),
})
type PrometheusMatrixResult =
  (typeof PrometheusMatrixResponse.Type)["data"]["result"]

const epochMillisecondsToHrTime = (
  epochMilliseconds: number,
): [number, number] => {
  const seconds = Math.floor(epochMilliseconds / 1_000)
  return [seconds, (epochMilliseconds - seconds * 1_000) * 1_000_000]
}

const timestampDataPoints = <T>(
  dataPoints: DataPoint<T>[],
  startTime: [number, number],
  endTime: [number, number],
): DataPoint<T>[] =>
  dataPoints.map((dataPoint) => ({ ...dataPoint, startTime, endTime }))

const timestampMetric = (
  metric: MetricData,
  startTime: [number, number],
  endTime: [number, number],
): MetricData =>
  metric.dataPointType === DataPointType.SUM
    ? {
        ...metric,
        dataPoints: timestampDataPoints(metric.dataPoints, startTime, endTime),
      }
    : metric

const timestampResourceMetrics = (
  metrics: ResourceMetrics,
  startTime: [number, number],
  endTime: [number, number],
): ResourceMetrics => ({
  ...metrics,
  scopeMetrics: metrics.scopeMetrics.map((scopeMetrics) => ({
    ...scopeMetrics,
    metrics: scopeMetrics.metrics.map((metric) =>
      timestampMetric(metric, startTime, endTime),
    ),
  })),
})

export const makeTimestampedMetricExporter = (
  exporter: OTLPMetricExporter,
  timestamps: readonly [number, ...number[]],
): PushMetricExporter => {
  const startTime = epochMillisecondsToHrTime(timestamps[0] - 60_000)
  let timestampIndex = 0

  return {
    export: (metrics, resultCallback) => {
      const timestamp = timestamps[timestampIndex]
      timestampIndex += 1
      exporter.export(
        timestamp === undefined
          ? metrics
          : timestampResourceMetrics(
              metrics,
              startTime,
              epochMillisecondsToHrTime(timestamp),
            ),
        resultCallback,
      )
    },
    forceFlush: () => exporter.forceFlush(),
    selectAggregation: (instrumentType) =>
      exporter.selectAggregation(instrumentType),
    selectAggregationTemporality: (instrumentType) =>
      exporter.selectAggregationTemporality(instrumentType),
    shutdown: () => exporter.shutdown(),
  }
}

export const queryPrometheusUntil = async ({
  prometheusUrl,
  query,
  ready,
  time,
}: {
  readonly prometheusUrl: string
  readonly query: string
  readonly ready: (results: PrometheusVectorResult) => boolean
  readonly time?: number
}): Promise<PrometheusVectorResult> => {
  let latest: PrometheusVectorResult = []

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const url = new URL("/api/v1/query", prometheusUrl)
    url.searchParams.set("query", query)
    if (time !== undefined) url.searchParams.set("time", time.toString())
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Prometheus query failed with HTTP ${response.status}`)
    }
    latest = await Schema.decodeUnknownPromise(PrometheusVectorResponse)(
      await response.json(),
    ).then((result) => result.data.result)
    if (ready(latest)) return latest
    await Bun.sleep(250)
  }

  throw new Error(
    `Prometheus query did not converge: ${JSON.stringify(latest)}`,
  )
}

export const queryPrometheusRangeUntil = async (options: {
  readonly prometheusUrl: string
  readonly query: string
  readonly start: number
  readonly end: number
  readonly step: number
  readonly ready: (results: PrometheusMatrixResult) => boolean
}): Promise<PrometheusMatrixResult> => {
  let latest: PrometheusMatrixResult = []

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const url = new URL("/api/v1/query_range", options.prometheusUrl)
    url.searchParams.set("query", options.query)
    url.searchParams.set("start", options.start.toString())
    url.searchParams.set("end", options.end.toString())
    url.searchParams.set("step", options.step.toString())
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Prometheus range query failed with HTTP ${response.status}`,
      )
    }
    latest = await Schema.decodeUnknownPromise(PrometheusMatrixResponse)(
      await response.json(),
    ).then((result) => result.data.result)
    if (options.ready(latest)) return latest
    await Bun.sleep(250)
  }

  throw new Error(
    `Prometheus range query did not converge: ${JSON.stringify(latest)}`,
  )
}
