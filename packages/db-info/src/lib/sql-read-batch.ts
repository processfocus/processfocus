import type { Effect } from "effect"
import { Context, Data } from "effect"
import type { SqlError } from "effect/sql/SqlError"

export interface SqlReadStatement {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

export type SqlReadRows = ReadonlyArray<ReadonlyArray<unknown>>

/**
 * Statement failure carried in SqlError.reason.cause. Indices are zero-based.
 * Results retain input order: null denotes the failed or a skipped statement.
 * Earlier successful reads are retained; the batch is never replayed.
 */
export class SqlReadBatchError extends Data.TaggedError("SqlReadBatchError")<{
  readonly statementIndex: number
  readonly results: ReadonlyArray<SqlReadRows | null>
  readonly message: string
  readonly cause: unknown
}> {}

/** Optional driver capability. Only explicitly grouped independent reads belong here. */
export class SqlReadBatch extends Context.Service<
  SqlReadBatch,
  {
    readonly execute: (
      statements: ReadonlyArray<SqlReadStatement>,
    ) => Effect.Effect<ReadonlyArray<SqlReadRows>, SqlError>
  }
>()("@pf/db-info/SqlReadBatch") {}
