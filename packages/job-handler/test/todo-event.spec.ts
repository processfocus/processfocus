import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  type TodoRow,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import {
  TODO_EVENT_QUEUE,
  TodoFromJobPublisher,
  todoEventHandler,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import { OrganisationProvider } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { TodoSummaryComputationLive } from "@pf/todo-summary"
import { createTestOrganisation } from "./test-org"
import { describe, expect, it } from "bun:test"

/**
 * Creates a mock TodoFromJobPublisher that captures published todos.
 */
const createMockTodoFromJobPublisher = () => {
  const publishedTodos: TodoRow[] = []
  const layer = Layer.succeed(TodoFromJobPublisher, {
    publishTodosCreated: (todos) =>
      Effect.sync(() => {
        for (const todo of todos) {
          publishedTodos.push(todo)
        }
      }),
  })
  return { layer, publishedTodos }
}

/**
 * Creates the test layers for todo-event handler tests.
 */
const createTestLayers = (
  mockPublisherLayer: Layer.Layer<TodoFromJobPublisher>,
) => {
  const { org } = createTestOrganisation()
  const OrgProviderLayer = Layer.succeed(OrganisationProvider, {
    organisation: org,
    orgPath: "/test/org",
    schemaPath: "/test/org/org.graphql",
  })
  const RequestTimeLive = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  )
  const UserDetailsLive = Layer.succeed(
    UserDetails,
    FiberRef.unsafeMake({
      by: "TEST_USER",
      id: "TEST_USER",
    }) as FiberRef.FiberRef<UserDetailsValue>,
  )

  const DbOperationsLayer = SqliteDbOperationsLive.pipe(
    Layer.provide(DatabaseTest),
  )

  // TodoSummaryComputationLive needs StepCompletionOperations and OrganisationProvider
  const TodoSummaryComputationWithDeps = TodoSummaryComputationLive.pipe(
    Layer.provide(SqliteGraphqlDbOperationsLive),
    Layer.provide(OrgProviderLayer),
    Layer.provide(DatabaseTest),
  )

  return Layer.mergeAll(
    SqliteCompletedJobOperationsLive,
    SqliteGraphqlDbOperationsLive,
    RequestTimeLive,
    UserDetailsLive,
    mockPublisherLayer,
    DbOperationsLayer,
    TodoSummaryComputationWithDeps,
  ).pipe(Layer.provideMerge(DatabaseTest))
}

describe("Todo Event Handler", () => {
  it("should fetch todos and publish events", async () => {
    const { layer: mockPublisherLayer, publishedTodos } =
      createMockTodoFromJobPublisher()
    const TestLayers = createTestLayers(mockPublisherLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      // Store org in database (creates steps, flows, etc.)
      yield* storeOrganisation(org)

      // Query the flow
      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      // Query the process
      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      // Create process state
      const processStateId = "pst-test-001"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      // Create process execution
      const processExecutionId = "pex-test-001"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      // Insert a todo directly (simulating what flow-execution handler does)
      const todoId = "todo-test-001"
      yield* db.insert(schema.toDo).values({
        id: todoId,
        processExecutionId,
        flowId: flow.id,
      })

      // Create and run the todo-event job
      const now = yield* DateTime.now
      const job = {
        jobId: "job-test-001",
        queue: TODO_EVENT_QUEUE,
        payload: { todoIds: [todoId] },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      yield* todoEventHandler.handle(job)

      // Verify todo was published
      expect(publishedTodos).toHaveLength(1)
      const publishedTodo = publishedTodos[0]
      if (!publishedTodo) throw new Error("Published todo not found")
      expect(publishedTodo.id).toBe(todoId)
      expect(publishedTodo.processExecutionId).toBe(processExecutionId)
      expect(publishedTodo.flowId).toBe(flow.id)

      // Verify job was marked as completed
      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        TODO_EVENT_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)
    })

    await Effect.runPromise(
      Effect.provide(testProgram, TestLayers) as Effect.Effect<void>,
    )
  })

  it("should skip processing when job was already completed (idempotency)", async () => {
    const { layer: mockPublisherLayer, publishedTodos } =
      createMockTodoFromJobPublisher()
    const TestLayers = createTestLayers(mockPublisherLayer)

    const testProgram = Effect.gen(function* () {
      const { org } = createTestOrganisation()
      yield* storeOrganisation(org)

      const db = yield* TypedSqliteDrizzle
      const flows = yield* db.select().from(schema.flow)
      const flow = flows[0]
      if (!flow) throw new Error("Flow not found")

      const processes = yield* db.select().from(schema.process)
      const process = processes[0]
      if (!process) throw new Error("Process not found")

      const processStateId = "pst-test-002"
      yield* db.insert(schema.processState).values({
        id: processStateId,
        processId: process.id,
        startStepId: flow.sourceStepId,
        state: { data: "test" },
      })

      const processExecutionId = "pex-test-002"
      yield* db.insert(schema.processExecution).values({
        id: processExecutionId,
        processStateId,
      })

      const todoId = "todo-test-002"
      yield* db.insert(schema.toDo).values({
        id: todoId,
        processExecutionId,
        flowId: flow.id,
      })

      const now = yield* DateTime.now
      const job = {
        jobId: "job-test-002",
        queue: TODO_EVENT_QUEUE,
        payload: { todoIds: [todoId] },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      // Pre-mark the job as completed
      const completedJobOps = yield* CompletedJobOperations
      yield* completedJobOps.markJobCompleted(TODO_EVENT_QUEUE, job.jobId)

      // Run the handler (should skip)
      yield* todoEventHandler.handle(job)

      // Verify no todos were published (job was skipped)
      expect(publishedTodos).toHaveLength(0)
    })

    await Effect.runPromise(
      Effect.provide(testProgram, TestLayers) as Effect.Effect<void>,
    )
  })

  it("should handle missing todos gracefully (flow-execution rolled back)", async () => {
    const { layer: mockPublisherLayer, publishedTodos } =
      createMockTodoFromJobPublisher()
    const TestLayers = createTestLayers(mockPublisherLayer)

    const testProgram = Effect.gen(function* () {
      // Don't create any todos in the database (simulating rollback)
      const now = yield* DateTime.now
      const job = {
        jobId: "job-test-003",
        queue: TODO_EVENT_QUEUE,
        payload: { todoIds: ["nonexistent-todo-id"] },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }

      // Run the handler (should handle gracefully)
      yield* todoEventHandler.handle(job)

      // Verify no todos were published (none found)
      expect(publishedTodos).toHaveLength(0)

      // Verify job was still marked as completed (to prevent infinite retries)
      const completedJobOps = yield* CompletedJobOperations
      const isCompleted = yield* completedJobOps.isJobCompleted(
        TODO_EVENT_QUEUE,
        job.jobId,
      )
      expect(isCompleted).toBe(true)
    })

    await Effect.runPromise(
      Effect.provide(testProgram, TestLayers) as Effect.Effect<void>,
    )
  })
})
