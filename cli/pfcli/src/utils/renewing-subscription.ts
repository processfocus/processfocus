import { Effect, Result } from "effect"
import type { GitHubWorkloadCredentialSource } from "@pf/openauth/github-workload"
import { CliError } from "../errors"

interface Source<T> extends AsyncIterable<T> {
  readonly close: () => Promise<void>
}

/** Rotate only the subscription, never its originating mutation. Persisted
 * execution polling remains authoritative for events in the reconnect gap. */
export const renewingSubscription = <T>(
  workload: GitHubWorkloadCredentialSource,
  open: (token: string) => Effect.Effect<Source<T>, CliError>,
): Effect.Effect<Source<T>, CliError> =>
  Effect.gen(function* () {
    const connect = workload.acquire.pipe(
      Effect.mapError(
        (cause) => new CliError({ message: cause.message, cause }),
      ),
      Effect.flatMap((credential) =>
        open(credential.accessToken).pipe(
          Effect.map((source) => ({ source, renewAt: credential.renewAt })),
        ),
      ),
    )
    let current = yield* connect
    const controller = new AbortController()
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = async () => {
      closed = true
      controller.abort()
      clearTimeout(timer)
      await current.source.close()
    }
    return {
      close,
      async *[Symbol.asyncIterator]() {
        try {
          let iterator = current.source[Symbol.asyncIterator]()
          while (!closed) {
            const next = await Promise.race([
              iterator
                .next()
                .then((result) => ({ kind: "event", result }) as const),
              new Promise<{ kind: "renew" }>((resolve) => {
                timer = setTimeout(
                  () => resolve({ kind: "renew" }),
                  Math.max(0, current.renewAt - Date.now()),
                )
              }),
            ])
            clearTimeout(timer)
            if (closed) return
            if (next.kind === "event") {
              if (next.result.done) return
              yield next.result.value
              continue
            }
            await current.source.close()
            const result = await Effect.runPromise(Effect.result(connect), {
              signal: controller.signal,
            })
            if (Result.isFailure(result)) throw result.failure
            current = result.success
            if (closed) {
              await current.source.close()
              return
            }
            iterator = current.source[Symbol.asyncIterator]()
          }
        } finally {
          await close()
        }
      },
    }
  })
