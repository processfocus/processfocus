import { Context, Effect, Layer } from "effect"
import { TodoQueries, type TodoRow } from "@pf/graphql-db-operations"
import type {
  Todo,
  TodoInputPushRowT0NewDocumentStateT0,
} from "@pf/graphql-schema"
import type { RxDbCollectionOps } from "./collection-ops"

/**
 * Map database row to GraphQL document type.
 */
const mapTodoRowToGraphql = (row: TodoRow): Effect.Effect<Todo, never> =>
  Effect.succeed({
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
 * RxDB collection operations for Todo.
 *
 * This service adapts the TodoQueries to the generic
 * RxDbCollectionOps interface, enabling use with the generic resolvers.
 *
 * Phase 1: Push operations are noop (read-only collection).
 */
export class TodoCollectionOps extends Context.Tag(
  "@pf/graphql-api/TodoCollectionOps",
)<
  TodoCollectionOps,
  RxDbCollectionOps<TodoRow, Todo, TodoInputPushRowT0NewDocumentStateT0>
>() {}

/**
 * Live implementation that delegates to TodoQueries.
 * Phase 1: Insert/update/delete operations return noop (not implemented).
 */
export const TodoCollectionOpsLive = Layer.effect(
  TodoCollectionOps,
  Effect.gen(function* () {
    const queries = yield* TodoQueries

    return {
      // Generic collection consumers require the historical all-row pull.
      // GraphQL replication calls TodoQueries directly with live-backfill mode.
      pull: (checkpoint, limit) =>
        queries.pullTodo(checkpoint, limit, { kind: "incremental" }),

      // Phase 1: noop implementations (todos are read-only)
      insert: () => Effect.succeed("noop"),
      update: () => Effect.succeed("noop"),
      delete: () => Effect.succeed("noop"),

      getByIds: queries.getTodos,

      mapToGraphql: mapTodoRowToGraphql,
    }
  }),
)
