import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Timestamp pair from a completed process execution.
 * Used for calculating business-hours duration.
 */
export interface ExecutionTimestampPair {
  /** The process this execution belongs to */
  processId: string
  /** The org unit ID of the process (for loading the correct calendar) */
  orgUnitId: string
  /** Execution start time in epoch milliseconds */
  createdAt: number
  /** Execution finish time in epoch milliseconds */
  finishedAt: number
}

/**
 * Default number of recent executions to sample per process.
 */
export const DEFAULT_DURATION_SAMPLE_SIZE = 10

/**
 * Service for querying execution timestamps for duration calculation.
 */
export class ExecutionDurationQueries extends Context.Tag(
  "@pf/graphql-db-operations/ExecutionDurationQueries",
)<
  ExecutionDurationQueries,
  {
    /**
     * Get recent execution timestamps for duration calculation.
     * Returns the N most recent completed executions per process.
     * Uses window functions to efficiently limit per-process.
     *
     * @param processIds - Process IDs to fetch executions for
     * @param sampleSize - Maximum number of executions per process
     * @returns Timestamp pairs for each completed execution
     */
    readonly getExecutionTimestamps: (
      processIds: string[],
      sampleSize: number,
    ) => Effect.Effect<ExecutionTimestampPair[], SqlError>
  }
>() {}
