import { Context, Effect, Ref } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export type TransactionMode = "concurrent" | "immediate"

export const concurrentTransactionRequested = Context.Reference<boolean>(
  "@pf/db-info/concurrentTransactionRequested",
  { defaultValue: () => false },
)
export const concurrentTransactionCommitError = Context.Reference<
  Ref.Ref<SqlError | undefined> | undefined
>("@pf/db-info/concurrentTransactionCommitError", {
  defaultValue: () => undefined,
})
export const transactionMode = Context.Reference<
  Ref.Ref<TransactionMode> | undefined
>("@pf/db-info/transactionMode", { defaultValue: () => undefined })

export const withConcurrentTransaction = <A, E, R>(
  client: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.gen(function* () {
    const commitError = yield* Ref.make<SqlError | undefined>(undefined)
    const mode = yield* Ref.make<TransactionMode>("immediate")
    return yield* Effect.gen(function* () {
      const result = yield* client.withTransaction(effect)
      const error = yield* Ref.get(commitError)
      if (error) return yield* Effect.fail(error)
      return result
    }).pipe(
      Effect.provideService(concurrentTransactionRequested, true),
      Effect.provideService(concurrentTransactionCommitError, commitError),
      Effect.provideService(transactionMode, mode),
    )
  })

export const getTransactionMode: Effect.Effect<TransactionMode> =
  Effect.flatMap(transactionMode, (mode) =>
    mode ? Ref.get(mode) : Effect.succeed("immediate"),
  )
