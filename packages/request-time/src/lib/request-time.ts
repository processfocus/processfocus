import { Context, type DateTime, Effect, FiberRef } from "effect"

/**
 * Service providing a FiberRef with a single timestamp for all operations within a request.
 * This ensures all database operations and resolvers use the same timestamp,
 * providing consistency for RxDB replication and audit trails.
 *
 * The timestamp is updated at the start of each GraphQL request and inherited
 * by all resolver effects running in child fibers.
 *
 * @effect-leakable-service
 */
export class RequestTime extends Context.Tag("@pf/request-time/RequestTime")<
  RequestTime,
  FiberRef.FiberRef<DateTime.Utc>
>() {}

/**
 * Helper to get the current request timestamp from the RequestTime FiberRef.
 *
 * @example
 * ```typescript
 * const requestTime = yield* getRequestTime()
 * ```
 */
export const getRequestTime = (): Effect.Effect<
  DateTime.Utc,
  never,
  RequestTime
> => Effect.flatMap(RequestTime, FiberRef.get)
