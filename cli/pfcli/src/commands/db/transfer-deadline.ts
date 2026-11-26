import { Clock, Duration, Effect } from "effect"
import { CliError } from "../../errors"

/** Bounds the transfer, not the independently authorized server-side apply. */
export const withTransferDeadline = <A, R>(
  transfer: Effect.Effect<A, CliError, R>,
  expiresAt: string,
): Effect.Effect<A, CliError, R> =>
  Effect.gen(function* () {
    const remaining = Date.parse(expiresAt) - (yield* Clock.currentTimeMillis)
    const expired = () =>
      new CliError({
        message:
          "Database transfer capability expired. Run the command again to acquire fresh OIDC credentials; no database apply was retried.",
      })
    if (!Number.isFinite(remaining) || remaining <= 0) return yield* expired()
    return yield* transfer.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(remaining),
        orElse: () => Effect.fail(expired()),
      }),
    )
  })
