import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { PullCheckpoint } from "./draft-process-execution"

/**
 * Summary item for todo cards.
 */
export interface TodoSummaryItem {
  readonly label: string
  readonly value: string
}

export interface TodoRow {
  id: string
  processExecutionId: string
  flowId: string
  processName: string
  stepName: string
  stepPath: string
  processPath: string
  processOrgUnitPath: string
  rolePath: string | null
  assignedToProviderUserId: string | null
  assignedToProviderUserEmail: string | null
  role: string | null // null for system-executed steps
  description: string
  status: "Active" | "Completed" | "Correction Required"
  priority: string
  assignedAt: string // ISO date-time string
  dueAt: string | null // ISO date-time string (SLA target, pre-calculated)
  dueWarningAt: string | null // ISO date-time string (SLA warning threshold)
  formComplexity: string
  updatedAt: number
  deleted: boolean
  summary: TodoSummaryItem[]
}

export interface TodoListQuery {
  readonly offset: number
  readonly limit: number
  readonly processPath?: string | null | undefined
  readonly state?: TodoListStatePredicate | undefined
}

export type TodoListStatePredicate =
  | { readonly kind: "correction-required" }
  | { readonly kind: "correction-free"; readonly deleted: boolean }

export type TodoPullMode =
  | { readonly kind: "incremental" }
  | {
      readonly kind: "live-backfill"
      readonly head: PullCheckpoint | null
    }

/**
 * Service providing todo query operations for RxDB replication.
 */
export class TodoQueries extends Context.Tag(
  "@pf/graphql-db-operations/TodoQueries",
)<
  TodoQueries,
  {
    /**
     * Query todo rows from database for RxDB replication.
     *
     * Callers select live backfill, which excludes deleted todos up to a fixed
     * HEAD, or incremental replication, which includes deletions.
     * Results are ordered by (updatedAt, id).
     *
     * @param checkpoint - Optional checkpoint to resume from
     * @param limit - Maximum number of rows to return
     * @param mode - Replication mode and fixed backfill boundary
     * @returns Raw rows from database
     */
    readonly pullTodo: (
      checkpoint: PullCheckpoint | null | undefined,
      limit: number,
      mode: TodoPullMode,
    ) => Effect.Effect<TodoRow[], SqlError>

    /**
     * Return the latest (updatedAt, id) checkpoint across every todo,
     * including deleted rows. Returns null when the todo table is empty.
     */
    readonly getTodoReplicationHead: () => Effect.Effect<
      PullCheckpoint | null,
      SqlError
    >

    /**
     * Return the todos for the given ids.
     */
    readonly getTodos: (
      ids: readonly string[],
    ) => Effect.Effect<TodoRow[], SqlError>

    /**
     * Query a stable, filtered window for the organisation-runtime Todo list.
     * Cedar authorization is applied by the GraphQL layer before public paging.
     */
    readonly listTodos: (
      query: TodoListQuery,
    ) => Effect.Effect<TodoRow[], SqlError>
  }
>() {}
