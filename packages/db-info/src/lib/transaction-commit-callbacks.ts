import { Context, Effect, Option } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"

/** Diagnostics only: callbacks must not perform business work or compensation. */
export class TransactionCommitCallbacks extends Context.Service<
  TransactionCommitCallbacks,
  {
    readonly transactionKey: string
    readonly callbacks: Array<Effect.Effect<void>>
  }
>()("@pf/db-info/TransactionCommitCallbacks") {}

/** Keep successful savepoint diagnostics provisional until the outer commit. */
export const withTransactionCommitCallbacks =
  (
    transactionKey: string,
    withTransaction: SqlClient["withTransaction"],
  ): SqlClient["withTransaction"] =>
  (effect) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* Effect.serviceOption(TransactionCommitCallbacks)
        const callbacks: Array<Effect.Effect<void>> = []
        const result = yield* withTransaction(
          restore(effect).pipe(
            Effect.provideService(TransactionCommitCallbacks, {
              transactionKey,
              callbacks,
            }),
          ),
        )
        // This point is unreachable on body, savepoint or COMMIT failure.
        if (
          Option.isSome(parent) &&
          parent.value.transactionKey === transactionKey
        ) {
          parent.value.callbacks.push(...callbacks)
        } else {
          for (const callback of callbacks) yield* callback
        }
        return result
      }),
    )
