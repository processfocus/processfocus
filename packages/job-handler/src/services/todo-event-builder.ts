import type { TodoRow } from "@pf/graphql-db-operations"
import {
  PullCheckpointMode,
  type Todo,
  type TodoPullBulk,
} from "@pf/graphql-schema"

/**
 * Map a TodoRow from the database to the GraphQL Todo type.
 * This is a pure function with no side effects.
 *
 * @param row - Database row to convert
 * @returns GraphQL Todo object
 */
export const mapTodoRowToGraphql = (row: TodoRow): Todo => ({
  id: row.id,
  processExecutionId: row.processExecutionId,
  flowId: row.flowId,
  processName: row.processName,
  stepName: row.stepName,
  stepPath: row.stepPath,
  role: row.role ?? "System",
  description: row.description,
  status: row.status,
  priority: row.priority,
  assignedAt: row.assignedAt,
  dueAt: row.dueAt,
  formComplexity: row.formComplexity,
  updatedAt: row.updatedAt,
  deleted: row.deleted,
  summary: row.summary,
})

/**
 * Type alias for TodoChangeEvent - the event payload for todo subscriptions.
 */
export type TodoChangeEvent = TodoPullBulk

/**
 * Build a TodoChangeEvent from a list of TodoRows.
 * Returns null if the list is empty.
 *
 * @param todos - TodoRows to include in the event
 * @returns TodoChangeEvent or null if no todos
 */
export const buildTodoChangeEvent = (
  todos: readonly TodoRow[],
): TodoChangeEvent | null => {
  if (todos.length === 0) {
    return null
  }

  // Map all TodoRows to GraphQL format
  const documents = todos.map(mapTodoRowToGraphql)

  // Use the last todo for checkpoint (highest updatedAt)
  // Safe to use non-null assertion: length > 0 check above guarantees this exists
  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
  const lastTodo = documents[documents.length - 1]!

  return {
    documents,
    checkpoint: {
      id: lastTodo.id,
      updatedAt: lastTodo.updatedAt,
      mode: PullCheckpointMode.Incremental,
    },
  }
}
