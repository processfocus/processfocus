import { parseTraceParent } from "@opentelemetry/core"
import type { Scope } from "effect"
import { Cause, Context, Data, Effect, Option, Tracer } from "effect"
import {
  HttpEffect,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpTraceContext,
} from "effect/http"

// Exact, bounded vocabulary only: even an innocent-looking pathname or error
// name can contain a bearer secret. Never copy arbitrary segments or messages.
const diagnosticPath = (pathname: string): string => {
  switch (pathname) {
    case "/_health":
    case "/.well-known/jwks.json":
    case "/.well-known/oauth-authorization-server":
    case "/oauth/authorize":
    case "/oauth/token":
    case "/oauth/userinfo":
    case "/oauth/revoke":
    case "/oauth/logout":
    case "/oauth/passkeys":
    case "/oauth/*":
    case "/delegations":
      return pathname
  }
  const segments = pathname.split("/")
  if (segments.length === 4 && segments[1] === "oauth") {
    switch (segments[3]) {
      case "authorize":
      case "callback":
      case "challenge":
      case "verify":
      case "register":
      case "register-options":
      case "register-verify":
      case "authenticate":
      case "auth-options":
      case "auth-verify":
      case "registration-session-exchange":
        return `/oauth/:provider/${segments[3]}`
    }
  }
  return "/[unrecognized]"
}

const diagnosticMethod = (method: string): string => {
  switch (method) {
    case "GET":
    case "HEAD":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS":
      return method
    default:
      return "OTHER"
  }
}

const diagnosticError = (
  cause: Cause.Cause<HttpServerError.HttpServerError>,
): string => {
  if (cause.reasons.some(Cause.isDieReason)) return "Defect"
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      // HttpServerError reasons are a closed framework vocabulary; do not
      // serialize arbitrary tags supplied by defects or upstream services.
      if (reason.error instanceof HttpServerError.HttpServerError) {
        switch (reason.error.reason._tag) {
          case "InternalError":
            return "InternalError"
          case "RequestParseError":
            return "RequestParseError"
          case "ResponseError":
            return "ResponseError"
          case "RouteNotFound":
            return "RouteNotFound"
        }
      }
      return "TypedFailure"
    }
  }
  return "Interrupted"
}

class AuthResponseError extends Data.TaggedError("AuthResponseError")<{
  readonly message: string
  readonly response: HttpServerResponse.HttpServerResponse
}> {}

/** Shared HTTP boundary for local and Lambda Web Adapter auth servers. */
export const createAuthenticationFetchHandler = (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  runtime: Context.Context<never>,
  mode: "aws" | "local",
): ((req: Request) => Promise<Response>) => {
  // The auth span below owns HTTP tracing; do not also emit an adapter span.
  const requestRuntime = Context.add(
    runtime,
    HttpMiddleware.TracerDisabledWhen,
    () => true,
  )
  return (req) => {
    const url = new URL(req.url)
    const method = diagnosticMethod(req.method)
    const pathname = diagnosticPath(url.pathname)
    if (mode === "aws") {
      if (url.pathname === "/_health" && req.method === "GET") {
        return Promise.resolve(Response.json({ status: "ok" }))
      }
      if (
        req.method === "HEAD" &&
        url.pathname !== "/delegations" &&
        url.pathname !== "/oauth/passkeys"
      ) {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
    }
    const request = HttpServerRequest.fromWeb(req)
    const traceparent = parseTraceParent(req.headers.get("traceparent") ?? "")
    return HttpEffect.toWebHandlerWith<never, Effect.Services<typeof app>>(
      requestRuntime,
    )(
      app.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.catchCause((cause) => {
          // Only an exclusively typed router miss is expected. A combined
          // failure containing a defect or another error must remain a 500.
          if (
            cause.reasons.length > 0 &&
            cause.reasons.every(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof HttpServerError.HttpServerError &&
                reason.error.reason instanceof HttpServerError.RouteNotFound,
            )
          ) {
            return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          }
          const log = Effect.logError("Unhandled auth server request failure", {
            authFailure: {
              method,
              pathname,
              errorType: diagnosticError(cause),
            },
          })
          return Effect.currentSpan.pipe(
            Effect.matchEffect({
              onFailure: () => log,
              onSuccess: (span) =>
                log.pipe(
                  Effect.annotateLogs({
                    traceId: span.traceId,
                    spanId: span.spanId,
                  }),
                ),
            }),
            Effect.as(
              HttpServerResponse.text("Internal Server Error", { status: 500 }),
            ),
          )
        }),
        Effect.tap((response) =>
          Effect.annotateCurrentSpan({
            "http.status_code": response.status,
            "http.response.status_code": response.status,
          }),
        ),
        // End 5xx server spans as errors without changing the HTTP response.
        Effect.tap((response) =>
          response.status >= 500 && response.status < 600
            ? Effect.fail(
                new AuthResponseError({
                  message: `Auth HTTP ${response.status}`,
                  response,
                }),
              )
            : Effect.void,
        ),
        // Keep the safety net inside this span so structured logs retain trace
        // correlation, and never put arbitrary pathname segments in log spans.
        Effect.withSpan(
          `${mode === "aws" ? "auth " : ""}${method} ${pathname}`,
          {
            // Only incoming trace context can parent this request, not startup.
            root: true,
            kind: "server",
            parent: traceparent
              ? Tracer.externalSpan({
                  traceId: traceparent.traceId,
                  spanId: traceparent.spanId,
                  sampled: (traceparent.traceFlags & 1) === 1,
                })
              : Option.getOrUndefined(
                  HttpTraceContext.fromHeaders(request.headers),
                ),
            attributes: {
              "http.method": method,
              "http.request.method": method,
              "http.url": pathname,
            },
          },
        ),
        Effect.catch((error) => Effect.succeed(error.response)),
      ),
    )(req)
  }
}
