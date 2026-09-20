import { Effect } from "effect"
import type {
  BulkCheckpoint,
  Maybe,
  PullCheckpoint,
  RxDbDocument,
} from "@pf/graphql-schema"

type GenericPullBulk<T extends RxDbDocument> = {
  checkpoint: Maybe<BulkCheckpoint>
  documents: Array<T>
}

interface PullBulkOptions {
  readonly checkpoint: BulkCheckpoint | null
}

export const wrapAsPullBulk = <T extends RxDbDocument>(
  documents: T[],
  options?: PullBulkOptions,
): GenericPullBulk<T> => {
  // Derive checkpoint from last document or return null
  const lastDoc = documents[documents.length - 1]
  const newCheckpoint: BulkCheckpoint | null = options
    ? options.checkpoint
    : lastDoc
      ? {
          id: lastDoc.id,
          updatedAt: lastDoc.updatedAt,
        }
      : null
  return {
    documents,
    checkpoint: newCheckpoint,
  }
}

const compareCheckpoints = (left: PullCheckpoint, right: PullCheckpoint) =>
  left.updatedAt === right.updatedAt
    ? left.id === right.id
      ? 0
      : left.id > right.id
        ? 1
        : -1
    : left.updatedAt - right.updatedAt

export const scanAuthorizedPull = <
  RawRow,
  AuthorizedRow,
  PullError,
  PullContext,
  AuthorizationError,
  AuthorizationContext,
>(options: {
  readonly initialCheckpoint: PullCheckpoint | null
  readonly limit: number
  readonly pull: (
    checkpoint: PullCheckpoint | null,
    limit: number,
  ) => Effect.Effect<RawRow[], PullError, PullContext>
  readonly checkpointOf: (row: RawRow) => PullCheckpoint
  readonly authorizeRows: (
    rows: RawRow[],
  ) => Effect.Effect<AuthorizedRow[], AuthorizationError, AuthorizationContext>
  readonly idOfAuthorized: (row: AuthorizedRow) => string
}): Effect.Effect<
  AuthorizedRow[],
  PullError | AuthorizationError,
  PullContext | AuthorizationContext
> =>
  Effect.gen(function* () {
    const authorizedRows = new Map<
      string,
      { row: AuthorizedRow; checkpoint: PullCheckpoint }
    >()
    let checkpoint = options.initialCheckpoint

    while (authorizedRows.size < options.limit) {
      const rows = yield* options.pull(checkpoint, options.limit)
      if (rows.length === 0) break

      const firstRow = rows[0]
      const lastRow = rows[rows.length - 1]
      if (!firstRow || !lastRow) break

      const firstCheckpoint = options.checkpointOf(firstRow)
      const lastCheckpoint = options.checkpointOf(lastRow)
      if (
        (checkpoint && compareCheckpoints(firstCheckpoint, checkpoint) <= 0) ||
        compareCheckpoints(lastCheckpoint, firstCheckpoint) < 0
      ) {
        return yield* Effect.dieMessage(
          "Pull backend returned a non-advancing checkpoint page",
        )
      }

      const authorizedPage = yield* options.authorizeRows(rows)
      const pageById = new Map(
        authorizedPage.map((row) => [options.idOfAuthorized(row), row]),
      )

      // A later occurrence supersedes an earlier revision, including when its
      // changed contents are no longer authorized.
      for (const row of rows) {
        const rowCheckpoint = options.checkpointOf(row)
        authorizedRows.delete(rowCheckpoint.id)
        const authorizedRow = pageById.get(rowCheckpoint.id)
        if (authorizedRow) {
          authorizedRows.set(rowCheckpoint.id, {
            row: authorizedRow,
            checkpoint: rowCheckpoint,
          })
        }
      }

      if (authorizedRows.size >= options.limit || rows.length < options.limit) {
        break
      }

      checkpoint = lastCheckpoint
    }

    return [...authorizedRows.values()]
      .sort((left, right) =>
        compareCheckpoints(left.checkpoint, right.checkpoint),
      )
      .slice(0, options.limit)
      .map(({ row }) => row)
  })
