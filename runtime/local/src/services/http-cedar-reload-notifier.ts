import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Cause, Config, Effect, Layer, Option, Runtime } from "effect"
import { CedarReloadNotifierService } from "@pf/auth-local-cedar"
import { getEffectiveFrontendBaseUrl } from "@pf/frontend-endpoints/port-files"

/**
 * HTTP implementation of the CedarReloadNotifier service.
 * Calls the frontend's /api/revalidate endpoint to invalidate the cedar-policies cache tag.
 *
 * This is only active in local runtime mode where the frontend URL can be discovered
 * via the .frontend-port.json file.
 */
export const HttpCedarReloadNotifierLive = Layer.effect(
  CedarReloadNotifierService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const runtime = yield* Effect.runtime()

    // Get the revalidation secret - required for the frontend endpoint
    const revalidateSecret = yield* Config.option(
      Config.string("REVALIDATE_SECRET"),
    )

    if (Option.isNone(revalidateSecret)) {
      yield* Effect.logWarning(
        "REVALIDATE_SECRET not configured; Cedar reloads will skip frontend cache invalidation",
      )
    } else {
      yield* Effect.log(
        "Cedar reload notifier configured for frontend cache invalidation",
      )
    }

    return {
      onCedarReloaded: () => {
        // Fire-and-forget the HTTP request
        // This is intentionally synchronous (void) since it's called from
        // synchronous Cedar code. We use Runtime.runFork for async work.
        const effect = Effect.gen(function* () {
          if (Option.isNone(revalidateSecret)) {
            return
          }

          // Read the frontend base URL when the reload happens, not at layer
          // construction time, so a later-starting dev server can still be found.
          const baseUrl = getEffectiveFrontendBaseUrl()

          const request = yield* HttpClientRequest.post(
            `${baseUrl}/api/revalidate`,
          ).pipe(
            HttpClientRequest.bodyJson({
              path: "/settings",
              tag: "cedar-policies",
              secret: revalidateSecret.value,
            }),
          )

          yield* Effect.log(
            `Triggering frontend cache invalidation for cedar-policies and /settings at ${baseUrl}`,
          )

          // Execute the request and log outcome
          yield* httpClient.execute(request).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.scoped,
            Effect.matchEffect({
              onSuccess: () =>
                Effect.log(
                  `Successfully invalidated frontend cedar-policies cache and /settings at ${baseUrl}`,
                ),
              onFailure: (error) =>
                Effect.logWarning(
                  `Failed to invalidate frontend cache at ${baseUrl} (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
                ),
            }),
          )
        }).pipe(
          // HTTP request and response failures are handled above. This catch is
          // only for unexpected setup failures such as JSON body encoding.
          Effect.catchAllCause((cause) =>
            Effect.logWarning(
              `Failed to prepare frontend cache invalidation request (non-fatal): ${Cause.pretty(cause)}`,
            ),
          ),
        )

        // Fire and forget using the captured runtime - don't block the Cedar reload
        Runtime.runFork(runtime, effect)
      },
    }
  }),
)
