import { Context, type DateTime, type Effect } from "effect"

/** One timestamp captured at the request boundary and inherited by its child effects. */
export class RequestTime extends Context.Service<RequestTime, DateTime.Utc>()(
  "@pf/request-time/RequestTime",
) {}

export const getRequestTime = (): Effect.Effect<
  DateTime.Utc,
  never,
  RequestTime
> => RequestTime
