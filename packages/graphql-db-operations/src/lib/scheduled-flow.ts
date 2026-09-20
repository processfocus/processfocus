import type { SqlError } from "@effect/sql/SqlError"
import { Context, type DateTime, type Effect, type Option } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { UserDetails } from "./user-details"

/**
 * Options for inserting a scheduled flow.
 */
export interface InsertScheduledFlowOptions {
  /** When set, only evaluate the specific flow to this target step */
  readonly targetStepId?: string
  /** Target execution time for deferred flows (must be UTC) */
  readonly scheduledAt?: DateTime.Utc
  /** When true, this scheduled flow acts as a forEach barrier — flow proceeds only when all sibling todos complete */
  readonly forEachBarrier?: boolean
  /** Role that completed the source step (for completed_by_role on outgoing todos) */
  readonly completedByRoleId?: string
}

/**
 * Represents a scheduled flow record from the database.
 */
export interface ScheduledFlowData {
  /** Persisted initiating audit identity; absent for older implementations. */
  readonly createdBy?: string
  readonly processExecutionId: string
  readonly sourceStepId: string
  /** When set, only evaluate the specific flow to this target step */
  readonly targetStepId: string | null
  /** Target execution time for deferred flows (UTC) */
  readonly scheduledAt: DateTime.Utc | null
  /** Whether this is a forEach barrier scheduled flow */
  readonly forEachBarrier: boolean
  /** Role that completed the source step (for completed_by_role on outgoing todos) */
  readonly completedByRoleId: string | null
}

/**
 * Service providing scheduled flow database operations.
 *
 * Scheduled flows are used to implement a 2-phase commit pattern between
 * the database and the job queue:
 * 1. The GraphQL resolver inserts a scheduled_flow row inside the transaction
 * 2. The job handler validates the row exists before processing
 * 3. After processing, the scheduled_flow row is deleted
 *
 * This ensures crash-safety: if the server crashes after committing but before
 * enqueuing, the job can retry and find the scheduled_flow row.
 */
export class ScheduledFlowOperations extends Context.Tag(
  "@pf/graphql-db-operations/ScheduledFlowOperations",
)<
  ScheduledFlowOperations,
  {
    /**
     * Insert a scheduled flow record.
     * Should be called inside a transaction before enqueueing a job.
     * Returns the generated ID.
     *
     * @param processExecutionId - The process execution this flow belongs to
     * @param sourceStepId - The source step where the flow originates
     * @param options - Optional targetStepId (for specific flow evaluation) and scheduledAt (for deferred execution)
     */
    readonly insertScheduledFlow: (
      processExecutionId: string,
      sourceStepId: string,
      options?: InsertScheduledFlowOptions,
    ) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    /**
     * Insert a scheduled-flow handoff under a caller-owned stable identity, or
     * return the existing row's identity when the same handoff is replayed.
     */
    readonly insertOrGetScheduledFlow: (
      id: string,
      processExecutionId: string,
      sourceStepId: string,
      options?: InsertScheduledFlowOptions,
    ) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    /**
     * Get a scheduled flow by ID.
     * Returns None if not found.
     */
    readonly getScheduledFlow: (
      id: string,
    ) => Effect.Effect<Option.Option<ScheduledFlowData>, SqlError>

    /**
     * Delete a scheduled flow record.
     * Should be called after successful job processing.
     * Returns true if the row was deleted, false if it was already gone
     * (used for atomic barrier claiming via DELETE ... RETURNING).
     */
    readonly deleteScheduledFlow: (
      id: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Check if there are any pending scheduled flows for a process execution.
     * Returns true if there are pending flows (job not yet processed).
     */
    readonly hasPendingScheduledFlows: (
      processExecutionId: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Get the pending start scheduled_flow row for a specific execution/source step.
     * Returns null when the start flow has already been consumed.
     */
    readonly getPendingStartScheduledFlowId: (
      processExecutionId: string,
      sourceStepId: string,
    ) => Effect.Effect<string | null, SqlError>

    /**
     * Query step paths representing pending scheduled work for abandonment
     * authorization.
     *
     * Uses the concrete target step path when the scheduled flow already points
     * to a specific next step. Otherwise falls back to the source step path,
     * because flow evaluation from that source step is still pending.
     */
    readonly queryPendingAbandonStepPaths: (
      processExecutionId: string,
    ) => Effect.Effect<string[], SqlError>

    /**
     * Delete all scheduled flows for a process execution.
     * Used when abandoning an execution.
     *
     * @param processExecutionId - The process execution ID
     */
    readonly deleteScheduledFlowsForExecution: (
      processExecutionId: string,
    ) => Effect.Effect<void, SqlError>

    /**
     * Check if a scheduled flow ID was used as a forEach barrier.
     * Queries the to_do table to see if any todo references this ID
     * as its barrier_scheduled_flow_id.
     *
     * Used to distinguish "barrier already claimed" from "2-phase commit
     * visibility delay" when a scheduled_flow record is not found.
     */
    readonly wasBarrierScheduledFlow: (
      scheduledFlowId: string,
    ) => Effect.Effect<boolean, SqlError>
  }
>() {}
