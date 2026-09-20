import { Given, When } from "@cucumber/cucumber"
import { Data, Effect, Schedule } from "effect"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { withPausedLocalWorker } from "../support/local-worker-pause"
import { type TestWorld, isSqliteRetryableError } from "../support/world"

interface CleanupResult {
  data?: {
    cleanupExecutions: {
      todosDeleted: number
      scheduledFlowsDeleted: number
      executionsDeleted: number
      statesDeleted: number
      jobsDeleted: number
    }
  }
  errors?: Array<{ message: string }>
}

/**
 * Error class for retryable database errors.
 */
class DatabaseLockedError extends Data.TaggedError("DatabaseLockedError")<{
  readonly result: CleanupResult
}> {}

/**
 * Error class for fetch/network errors.
 */
class FetchError extends Data.TaggedError("FetchError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Check if a cleanup result contains a retryable error.
 */
const isRetryableError = (result: CleanupResult): boolean => {
  if (!result.errors?.length) return false
  return result.errors.some((e) => isSqliteRetryableError(e.message))
}

/**
 * Fetch cleanup result once, failing with DatabaseLockedError if retryable.
 */
const fetchCleanup = (accessToken: string | null) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(getEffectiveGraphqlEndpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            query: `
            mutation CleanupExecutions {
              cleanupExecutions {
                todosDeleted
                scheduledFlowsDeleted
                executionsDeleted
                statesDeleted
                jobsDeleted
              }
            }
          `,
          }),
        }),
      catch: (error) =>
        new FetchError({
          message: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })

    const result = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) =>
        new FetchError({
          message: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    })) as CleanupResult

    if (isRetryableError(result)) {
      return yield* new DatabaseLockedError({ result })
    }

    return result
  })

/**
 * Retry schedule: exponential backoff (500ms, 1s, 2s) up to 3 retries.
 */
const retrySchedule = Schedule.intersect(
  Schedule.exponential("500 millis"),
  Schedule.recurs(3),
)

/**
 * Call cleanupExecutions mutation with retry logic for transient errors.
 * Retries up to 3 times with exponential backoff for database lock errors.
 */
const callCleanupExecutions = (
  accessToken: string | null,
): Promise<CleanupResult> =>
  fetchCleanup(accessToken).pipe(
    Effect.retry({
      schedule: retrySchedule,
      while: (error) => error instanceof DatabaseLockedError,
    }),
    Effect.catchTag("DatabaseLockedError", (error) =>
      Effect.succeed(error.result),
    ),
    Effect.catchTag("FetchError", (error) =>
      Effect.succeed({
        errors: [{ message: error.message }],
      }),
    ),
    Effect.runPromise,
  )

/**
 * Step definition for cleaning up all execution data.
 * This ensures test isolation by removing all todos, executions, etc.
 */
Given(
  "the database is clean",
  // Cleanup may first wait for an active worker job to drain before the mutation.
  { timeout: 45000 },
  async function (this: TestWorld) {
    const result = await withPausedLocalWorker(() =>
      callCleanupExecutions(this.accessToken),
    )

    if (result.errors?.length) {
      throw new Error(
        `Cleanup failed: ${result.errors.map((e) => e.message).join(", ")}`,
      )
    }

    // Reset world state for fresh scenario.
    // Auth state (accessToken, authError) is preserved as it's set per-scenario.
    this.startProcessResult = undefined
    this.todoDocuments = undefined
    this.todoListPages = []
    this.executionListPages = []
    this.executionDocuments = undefined
    this.orgResult = undefined
    this.cedarPoliciesResult = undefined
    this.workflowResult = undefined
    this.draftProcessExecutionResult = undefined
    this.graphqlError = undefined
    this.processDocuments = undefined
    this.completeStepResult = undefined
    this.pushedDraftId = null
    this.pushedProcessName = null

    // Clean up any active subscription to prevent cross-scenario event leakage
    this.unsubscribe()
    this.subscriptionEvents = []
    this.subscriptionError = null
  },
)

/**
 * Attempt to call cleanupExecutions, capturing any errors.
 * Used for testing authorization - provider users should be denied.
 */
When(
  "I attempt to call cleanupExecutions",
  { timeout: 45000 },
  async function (this: TestWorld) {
    const result = await withPausedLocalWorker(() =>
      callCleanupExecutions(this.accessToken),
    )

    if (result.errors?.length && result.errors[0]) {
      this.graphqlError = new Error(result.errors[0].message)
    } else {
      this.graphqlError = undefined
    }
  },
)

/**
 * Call cleanupExecutions expecting success.
 * Used for testing that service accounts can access CI-only mutations.
 */
When(
  "I call cleanupExecutions",
  { timeout: 45000 },
  async function (this: TestWorld) {
    const result = await withPausedLocalWorker(() =>
      callCleanupExecutions(this.accessToken),
    )

    if (result.errors?.length && result.errors[0]) {
      this.graphqlError = new Error(result.errors[0].message)
    } else {
      this.graphqlError = undefined
    }
  },
)
