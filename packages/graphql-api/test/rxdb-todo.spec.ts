import { Effect, FiberRef, Layer } from "effect"
import {
  TodoQueries,
  type TodoRow,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { TodoCollectionOps, TodoCollectionOpsLive } from "../src/lib/rxdb/todo"
import { describe, expect, it } from "bun:test"

const deletedTodo: TodoRow = {
  id: "todo-deleted",
  processExecutionId: "execution-1",
  flowId: "flow-1",
  processName: "Import",
  stepName: "Completed step",
  stepPath: "/import/completed-step",
  processPath: "/import",
  processOrgUnitPath: "/",
  rolePath: null,
  assignedToProviderUserId: null,
  assignedToProviderUserEmail: null,
  role: null,
  description: "Completed during import",
  status: "Completed",
  priority: "Medium",
  assignedAt: "2026-09-04T00:00:00.000Z",
  dueAt: null,
  dueWarningAt: null,
  formComplexity: "simple",
  updatedAt: 1,
  deleted: true,
  summary: [],
}

describe("TodoCollectionOps", () => {
  it("keeps its all-row pull contract for import event replay", async () => {
    const TodoQueriesTest = Layer.succeed(TodoQueries, {
      pullTodo: (_checkpoint, _limit, mode) =>
        Effect.succeed(mode.kind === "incremental" ? [deletedTodo] : []),
      getTodoReplicationHead: () => Effect.succeed(null),
      listTodos: () => Effect.succeed([]),
      getTodos: () => Effect.succeed([]),
    })
    const TestLayer = TodoCollectionOpsLive.pipe(Layer.provide(TodoQueriesTest))

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const todoOps = yield* TodoCollectionOps
        return yield* todoOps.pull(null, 10_000)
      }).pipe(
        Effect.provide(TestLayer),
        Effect.provideService(
          UserDetails,
          FiberRef.unsafeMake<UserDetailsValue>({ by: "test", id: null }),
        ),
      ),
    )

    expect(rows).toEqual([deletedTodo])
  })
})
