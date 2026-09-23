import * as OtelTracer from "@effect/opentelemetry/Tracer"
import {
  type Context,
  ROOT_CONTEXT,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { Effect } from "effect"

export type TraceCarrier = {
  readonly traceparent: string
  readonly tracestate?: string
}
const propagator = new W3CTraceContextPropagator()

/** Untrusted telemetry is optional and never affects business payload validation. */
export const extractTraceContext = (carrier: unknown): Context => {
  if (typeof carrier !== "object" || carrier === null) return ROOT_CONTEXT
  const fields: Record<string, string> = {}
  if ("traceparent" in carrier && typeof carrier.traceparent === "string")
    fields["traceparent"] = carrier.traceparent
  if ("tracestate" in carrier && typeof carrier.tracestate === "string")
    fields["tracestate"] = carrier.tracestate
  return propagator.extract(ROOT_CONTEXT, fields, defaultTextMapGetter)
}

export const captureTraceContext: Effect.Effect<TraceCarrier | undefined> =
  OtelTracer.currentOtelSpan.pipe(
    Effect.map((span) => {
      const fields: Record<string, string> = {}
      propagator.inject(
        trace.setSpan(ROOT_CONTEXT, span),
        fields,
        defaultTextMapSetter,
      )
      const traceparent = fields["traceparent"]
      return traceparent
        ? {
            traceparent,
            ...(fields["tracestate"]
              ? { tracestate: fields["tracestate"] }
              : {}),
          }
        : undefined
    }),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

export const withTraceContext =
  (carrier: unknown) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const parent = trace.getSpanContext(extractTraceContext(carrier))
    return parent ? OtelTracer.withSpanContext(work, parent) : work
  }

/** Bound telemetry cleanup without changing the operation's outcome. */
export const settleTelemetry = async (
  operation: () => Promise<unknown>,
  timeoutMs = 2000,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } catch {
    // Export is best effort. Never log exporter errors containing endpoint credentials.
  } finally {
    clearTimeout(timer)
  }
}
