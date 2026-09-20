import { Duration, Effect } from "effect"
import type { GraphQLResolveInfo } from "graphql"
import { AuthorizedPageTimeoutError } from "@pf/graphql-schema"
import { MAX_PAGE_SIZE } from "@pf/process"
import type { UserContext } from "./types"

interface PaginatedCollectionArgs {
  readonly page: number
  readonly limit: number
}

export interface PaginationWindow {
  readonly page: number
  readonly limit: number
}

export interface PaginatedCollectionResult<TItem> {
  readonly items: readonly TItem[]
  readonly totalCount: number
}

interface AuthorizedPageOptions<
  TRow,
  QueryError,
  QueryRequirements,
  AuthorizationError,
  AuthorizationRequirements,
> {
  readonly pagination: PaginationWindow
  readonly timeBudget?: Duration.DurationInput
  readonly queryRows: (window: {
    readonly offset: number
    readonly limit: number
  }) => Effect.Effect<readonly TRow[], QueryError, QueryRequirements>
  readonly authorizeRows: (
    rows: readonly TRow[],
  ) => Effect.Effect<
    readonly TRow[],
    AuthorizationError,
    AuthorizationRequirements
  >
}

const DEFAULT_AUTHORIZED_PAGE_TIME_BUDGET = Duration.seconds(5)

/**
 * Build a page over authorized rows while querying storage in bounded chunks.
 * Authorization must happen before public pagination so denied rows neither
 * leave sparse pages nor shift visible rows onto later pages.
 */
export const queryAuthorizedPage = <
  TRow,
  QueryError,
  QueryRequirements,
  AuthorizationError,
  AuthorizationRequirements,
>(
  options: AuthorizedPageOptions<
    TRow,
    QueryError,
    QueryRequirements,
    AuthorizationError,
    AuthorizationRequirements
  >,
) =>
  Effect.gen(function* () {
    const pageStart = (options.pagination.page - 1) * options.pagination.limit
    const pageEnd = pageStart + options.pagination.limit
    const pageRows: TRow[] = []
    let authorizedCount = 0
    let offset = 0
    let exhausted = false

    while (authorizedCount <= pageEnd && !exhausted) {
      const rows = yield* options.queryRows({
        offset,
        limit: MAX_PAGE_SIZE,
      })
      if (rows.length === 0) {
        exhausted = true
        continue
      }

      offset += rows.length
      const authorizedRows = yield* options.authorizeRows(rows)
      for (const row of authorizedRows) {
        if (authorizedCount >= pageStart) pageRows.push(row)
        authorizedCount += 1
        if (authorizedCount > pageEnd) break
      }
      exhausted = rows.length < MAX_PAGE_SIZE
      if (!exhausted && authorizedCount <= pageEnd) {
        yield* Effect.yieldNow()
      }
    }

    return {
      nodes: pageRows.slice(0, options.pagination.limit),
      page: options.pagination.page,
      limit: options.pagination.limit,
      hasNextPage: pageRows.length > options.pagination.limit,
    }
  }).pipe(
    Effect.timeoutFail({
      duration: options.timeBudget ?? DEFAULT_AUTHORIZED_PAGE_TIME_BUDGET,
      onTimeout: () =>
        new AuthorizedPageTimeoutError({
          message:
            "Authorized collection paging exceeded its time budget; narrow the query with filters or request an earlier page",
          page: options.pagination.page,
          limit: options.pagination.limit,
        }),
    }),
  )

export const clampPaginationWindow = (
  args: PaginatedCollectionArgs,
): PaginationWindow => ({
  page: Math.max(1, args.page),
  limit: Math.min(MAX_PAGE_SIZE, Math.max(1, args.limit)),
})

export const buildPaginatedCollectionPayload = <TItem>(
  pagination: PaginationWindow,
  result: PaginatedCollectionResult<TItem>,
) => ({
  items: result.items,
  totalCount: result.totalCount,
  page: pagination.page,
  limit: pagination.limit,
  hasNextPage: pagination.page * pagination.limit < result.totalCount,
})

export const createPaginatedCollectionResolver = <
  TArgs extends PaginatedCollectionArgs,
  TItem,
  E,
  R,
>(
  resolve: (
    args: TArgs,
    pagination: PaginationWindow,
    context: UserContext,
  ) => Effect.Effect<PaginatedCollectionResult<TItem>, E, R>,
) => {
  return (
    _parent: unknown,
    args: TArgs,
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      const pagination = clampPaginationWindow(args)
      const result = yield* resolve(args, pagination, context)
      return buildPaginatedCollectionPayload(pagination, result)
    })
}
