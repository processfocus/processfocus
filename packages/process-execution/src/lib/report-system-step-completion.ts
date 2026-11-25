import { Effect, Option } from "effect"
import type { SqlClient } from "effect/sql"
import { TransactionCommitCallbacks } from "@pf/db-info"

/** Called only after a completion transaction returned a non-skipped outcome. */
export const reportSystemStepCompletion = (
  sqlClient: SqlClient.SqlClient,
  message: string,
  fields: Record<string, string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const committed = Effect.logInfo(message, fields)
    const transaction = yield* Effect.serviceOption(
      sqlClient.transactionService,
    )
    if (Option.isNone(transaction)) {
      yield* committed
      return
    }

    // A successful savepoint is not a commit. Drivers without callback
    // integration retain the existing provisional staging diagnostics only.
    const callbacks = yield* Effect.serviceOption(TransactionCommitCallbacks)
    if (
      Option.isSome(callbacks) &&
      callbacks.value.transactionKey === sqlClient.transactionService.key
    ) {
      const context = yield* Effect.context<never>()
      callbacks.value.callbacks.push(committed.pipe(Effect.provide(context)))
    }
  })
