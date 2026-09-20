import type * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import * as Effect from "effect/Effect"
import * as FiberRef from "effect/FiberRef"

export type TransactionMode = "concurrent" | "immediate"

export const concurrentTransactionRequested = FiberRef.unsafeMake(false)
export const concurrentTransactionCommitError = FiberRef.unsafeMake<
  SqlError | undefined
>(undefined)
export const transactionMode = FiberRef.unsafeMake<TransactionMode>("immediate")

export const withConcurrentTransaction = <A, E, R>(
  client: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.gen(function* () {
    const result = yield* client.withTransaction(effect)
    const commitError = yield* FiberRef.get(concurrentTransactionCommitError)
    if (commitError) {
      return yield* Effect.fail(commitError)
    }

    return result
  }).pipe(
    Effect.locally(concurrentTransactionRequested, true),
    Effect.locally(concurrentTransactionCommitError, undefined),
    Effect.locally(transactionMode, "immediate"),
  )

export const getTransactionMode: Effect.Effect<TransactionMode> =
  FiberRef.get(transactionMode)
