import {
  type HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Effect, Option } from "effect"

/**
 * POST a JSON event to a local GraphQL internal endpoint, optionally
 * attaching the callback secret header.
 */
export const postInternalEvent = <E>(
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  path: string,
  event: unknown,
  callbackSecret: Option.Option<string>,
  wrapError: (cause: unknown) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    let request = HttpClientRequest.post(`${baseUrl}${path}`)
    request = yield* HttpClientRequest.bodyJson(request, event).pipe(
      Effect.mapError(wrapError),
    )
    request = Option.match(callbackSecret, {
      onNone: () => request,
      onSome: (secret) =>
        HttpClientRequest.setHeader(request, "x-callback-secret", secret),
    })

    yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(wrapError),
        Effect.asVoid,
      )
  })
