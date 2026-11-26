import { Effect } from "effect"
import { HttpRouter } from "effect/http"

/** Build provider routes in the current request scope, preserving request services. */
export const makeRouter = <Routes extends ReadonlyArray<HttpRouter.Route<unknown, unknown>>>(routes: Routes) =>
  HttpRouter.toHttpEffect(HttpRouter.addAll(routes)).pipe(
    Effect.flatten,
  )
