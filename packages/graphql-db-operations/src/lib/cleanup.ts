import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
  /** Number of todos deleted */
  readonly todosDeleted: number
  /** Number of scheduled flows deleted */
  readonly scheduledFlowsDeleted: number
  /** Number of process executions deleted */
  readonly executionsDeleted: number
  /** Number of process states deleted */
  readonly statesDeleted: number
  /** Number of job queue entries deleted */
  readonly jobsDeleted: number
}

/**
 * Service providing cleanup operations for test isolation.
 *
 * This service is intended for use in e2e tests to ensure each scenario
 * starts with a clean slate. It deletes all execution-related data
 * (todos, scheduled flows, process executions, process states, and job queue entries).
 *
 * IMPORTANT: This should only be available in test environments.
 */
export class CleanupOperations extends Context.Tag(
  "@pf/graphql-db-operations/CleanupOperations",
)<
  CleanupOperations,
  {
    /**
     * Delete all execution-related data from the database.
     * This includes: todos, scheduled flows, process executions,
     * process states, and job queue entries.
     *
     * Returns counts of deleted records for each table.
     */
    readonly cleanupExecutions: () => Effect.Effect<CleanupResult, SqlError>
  }
>() {}
