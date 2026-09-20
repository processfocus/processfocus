import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import { Data, Effect, Schedule } from "effect"
import type { TestWorld } from "../support/world"

/** Tagged error for retryable todo count mismatch */
class TodoCountMismatchError extends Data.TaggedError(
  "@pf/TodoCountMismatchError",
)<{
  readonly expected: number
  readonly actual: number
}> {}

/**
 * Shared todo-related step definitions used across multiple feature files.
 */

When(
  "I query for todos with limit {int}",
  async function (this: TestWorld, limit: number) {
    const client = this.getClient()
    const result = await client.query({
      pullTodo: {
        __args: { checkpoint: null, limit },
        documents: {
          id: true,
          description: true,
          dueAt: true,
          formComplexity: true,
          processExecutionId: true,
          processName: true,
          role: true,
          status: true,
          stepName: true,
          stepPath: true,
          deleted: true,
          summary: {
            label: true,
            value: true,
          },
        },
      },
    })
    // Filter out deleted documents - RxDB clients handle this locally
    // Also filter by current process execution if one exists
    const executionId = this.startProcessResult?.executionId
    this.todoDocuments = result.pullTodo.documents.filter(
      (doc) =>
        !doc.deleted &&
        (!executionId || doc.processExecutionId === executionId),
    )
  },
)

Then("I should receive a list of todos", function (this: TestWorld) {
  assert.ok(this.todoDocuments, "Query result should be defined")
  assert.ok(Array.isArray(this.todoDocuments), "Documents should be an array")
})

Then("each todo should have required fields", function (this: TestWorld) {
  assert.ok(this.todoDocuments, "No query result available")
  for (const todo of this.todoDocuments) {
    assert.ok(todo.id, "Todo should have an id")
    assert.ok(todo.status, "Todo should have a status")
    assert.ok(todo.stepPath, "Todo should have a stepPath")
  }
})

Then(
  "I should have {int} todo(s)",
  { timeout: 60000 },
  async function (this: TestWorld, count: number) {
    assert.ok(this.todoDocuments, "No query result available")

    // If count matches, we're done
    if (this.todoDocuments.length === count) {
      return
    }

    // Use Effect with retry for timing issues (e.g., job worker race conditions)
    const executionId = this.startProcessResult?.executionId
    const client = this.getClient()
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const todoDocumentsRef = { value: this.todoDocuments! }

    const queryTodos = Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        client.query({
          pullTodo: {
            __args: { checkpoint: null, limit: 100 },
            documents: {
              id: true,
              description: true,
              dueAt: true,
              formComplexity: true,
              processExecutionId: true,
              processName: true,
              role: true,
              status: true,
              stepName: true,
              stepPath: true,
              deleted: true,
              summary: {
                label: true,
                value: true,
              },
            },
          },
        }),
      )

      const todos = result.pullTodo.documents.filter(
        (doc) =>
          !doc.deleted &&
          (!executionId || doc.processExecutionId === executionId),
      )

      todoDocumentsRef.value = todos

      if (todos.length !== count) {
        return yield* new TodoCountMismatchError({
          expected: count,
          actual: todos.length,
        })
      }

      return todos
    })

    // Retry schedule for eventual consistency in deployed environments.
    // Local runs are fast; external runtime (BASE_URL set) can need longer due to
    // SQS/Lambda/DB propagation and cross-service visibility delays.
    const externalRuntime = Boolean(process.env["BASE_URL"])
    const maxRetries = externalRuntime ? 20 : 5
    const retrySchedule = Schedule.spaced("2 seconds").pipe(
      Schedule.intersect(Schedule.recurs(maxRetries)),
    )

    const effect = queryTodos.pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error instanceof TodoCountMismatchError,
      }),
    )

    await Effect.runPromise(effect).catch(() => {
      // Update this.todoDocuments with the last result for better error messages
      this.todoDocuments = todoDocumentsRef.value

      // Provide detailed error info for debugging
      assert.fail(
        `Expected ${count} todo(s) but got ${todoDocumentsRef.value.length} after retries.\n` +
          `External runtime: ${externalRuntime}\n` +
          `Max retries: ${maxRetries}\n` +
          `ExecutionId: ${executionId}\n` +
          `Todos: ${JSON.stringify(todoDocumentsRef.value.map((t) => ({ id: t.id, step: t.stepName, status: t.status, role: t.role })))}`,
      )
    })

    this.todoDocuments = todoDocumentsRef.value
  },
)

Then(
  "the todo should be for step {string}",
  function (this: TestWorld, stepName: string) {
    assert.ok(this.todoDocuments, "No query result available")
    assert.ok(this.todoDocuments.length > 0, "No todos available")
    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!
    assert.strictEqual(
      todo.stepName,
      stepName,
      `Expected todo for step "${stepName}" but got "${todo.stepName}"`,
    )
  },
)

Then(
  "the todo summary should contain {string} with value {string}",
  function (this: TestWorld, label: string, expectedValue: string) {
    assert.ok(this.todoDocuments, "No query result available")
    assert.ok(this.todoDocuments.length > 0, "No todos available")
    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!
    assert.ok(todo.summary, "Todo should have a summary")
    const summaryItem = todo.summary.find(
      (item: { label: string; value: string }) => item.label === label,
    )
    assert.ok(summaryItem, `Summary should contain label "${label}"`)
    assert.strictEqual(
      summaryItem.value,
      expectedValue,
      `Expected summary "${label}" to be "${expectedValue}" but got "${summaryItem.value}"`,
    )
  },
)

Then(
  "the todo summary should contain {string} with pattern {string}",
  function (this: TestWorld, label: string, pattern: string) {
    assert.ok(this.todoDocuments, "No query result available")
    assert.ok(this.todoDocuments.length > 0, "No todos available")
    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees this exists
    const todo = this.todoDocuments[0]!
    assert.ok(todo.summary, "Todo should have a summary")
    const summaryItem = todo.summary.find(
      (item: { label: string; value: string }) => item.label === label,
    )
    assert.ok(summaryItem, `Summary should contain label "${label}"`)
    const regex = new RegExp(`^${pattern}$`)
    assert.ok(
      regex.test(summaryItem.value),
      `Expected "${label}" value "${summaryItem.value}" to match pattern "${pattern}"`,
    )
  },
)

When(
  "I wait for flow to advance",
  { timeout: 90000 },
  async function (this: TestWorld) {
    assert.ok(
      this.startProcessResult,
      "No process started - cannot wait for jobs",
    )

    const executionId = this.startProcessResult.executionId

    // Poll until no pending scheduled flows remain
    // On AWS, chained system steps go through SQS → Lambda → Turso (cross-region)
    // cycles which can take 60+ seconds for 3 consecutive system steps
    const maxAttempts = 170
    const pollInterval = 500 // ms

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.executeGraphQL<{
        hasPendingScheduledFlows: boolean
      }>(
        `query HasPendingScheduledFlows($executionId: ID!) {
          hasPendingScheduledFlows(processExecutionId: $executionId)
        }`,
        { executionId },
      )

      if (!result.hasPendingScheduledFlows) {
        // No pending flows - job worker has completed
        return
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    throw new Error(
      `Timeout waiting for background jobs to complete after ${(maxAttempts * pollInterval) / 1000}s`,
    )
  },
)

Then("there are no more flows to advance", async function (this: TestWorld) {
  assert.ok(
    this.startProcessResult,
    "No process started - cannot check for pending flows",
  )

  const executionId = this.startProcessResult.executionId

  const result = await this.executeGraphQL<{
    hasPendingScheduledFlows: boolean
  }>(
    `query HasPendingScheduledFlows($executionId: ID!) {
      hasPendingScheduledFlows(processExecutionId: $executionId)
    }`,
    { executionId },
  )

  assert.strictEqual(
    result.hasPendingScheduledFlows,
    false,
    "Expected no more flows to advance, but hasPendingScheduledFlows returned true",
  )
})
