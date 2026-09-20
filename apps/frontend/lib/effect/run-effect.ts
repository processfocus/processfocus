import "server-only"
import { Effect, Layer, Logger } from "effect"
import { StdoutJsonLoggerLive } from "@pf/effect-json-logger"

export const LoggerLive =
  process.env["NODE_ENV"] === "production"
    ? StdoutJsonLoggerLive
    : Logger.pretty

export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, LoggerLive))

export const withLogger = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, never>> =>
  Layer.provide(layer, LoggerLive) as Layer.Layer<A, E, Exclude<R, never>>
