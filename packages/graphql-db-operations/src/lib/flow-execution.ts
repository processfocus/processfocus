import type { SqlError } from "@effect/sql/SqlError"
import type { DateTime } from "effect"
import { Context, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import { parseNotificationPreferences } from "./settings-queries"
import type { UserDetails } from "./user-details"

/**
 * Represents a flow record from the database with condition info.
 */
export interface FlowWithCondition {
  readonly id: string
  readonly condition: string | null
  /** Human-readable description of schedule, or null if not scheduled */
  readonly schedule: string | null
  /** Path of the source step (e.g., "finance/purchase-request/Submit request") */
  readonly sourceStepPath: string
  /** Database ID of the target step */
  readonly targetStepId: string
  /** Path of the target step (e.g., "finance/purchase-request/Manager approval") */
  readonly targetStepPath: string
  /** Whether this is a fallback/else branch (taken when no conditional flows match) */
  readonly fallbackBranch: boolean
  /** Whether this branch runs after terminal system-step failure */
  readonly isOnError: boolean
  /** Optional case-sensitive outer error tags matched by this error branch */
  readonly taggedErrors: readonly string[] | null
}

export const normalizeTaggedErrors = (
  value: Record<string, unknown> | unknown[] | null,
): readonly string[] | null =>
  Array.isArray(value) && value.every((tag) => typeof tag === "string")
    ? (value as readonly string[])
    : null

/**
 * Represents raw process state retrieved from database.
 * The state field is the raw JSON value; callers should validate/parse it.
 */
export interface ProcessStateRaw {
  readonly withoutWaiting?: boolean
  readonly createdBy?: string
  readonly processStateId: string
  readonly state: unknown
}

/**
 * Snapshotted to-do context needed when enqueueing notification deliveries.
 */
export interface TodoNotificationInfo {
  readonly todoId: string
  readonly processExecutionId: string
  readonly assignedToProviderUserId: string | null
  readonly roleId: string | null
  readonly stepPath: string
  readonly processName: string
  readonly stepName: string
  readonly itemData: Record<string, unknown> | unknown[] | null
}

/**
 * Provider-user recipient data used to snapshot notification deliveries.
 */
export interface NotificationRecipientRow {
  readonly providerUserId: string
  readonly userId: string
  readonly email: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly todoAssignmentEmailEnabled: boolean
  readonly executionFailureEmailEnabled: boolean
}

export interface FlowDispatchJob {
  readonly id: string
  readonly logicalJobId: string
  readonly queue: string
  readonly payload: Record<string, unknown>
  readonly retryLimit: number | null
  readonly scheduledAt: string | null
  readonly sequence: number
}

export interface NewFlowDispatchJob extends Omit<FlowDispatchJob, "id"> {
  readonly sourceScheduledFlowId: string
  readonly processExecutionId?: string
  /** Optional internal DB queue used to index an external-dispatch outbox. */
  readonly storageQueue?: string
}

export const mapNotificationRecipientRow = (row: {
  providerUserId: string
  userId: string
  email: string
  name: string
  firstName: string
  lastName: string
  notificationPreference: unknown
}): NotificationRecipientRow => ({
  providerUserId: row.providerUserId,
  userId: row.userId,
  email: row.email,
  name: row.name,
  firstName: row.firstName,
  lastName: row.lastName,
  todoAssignmentEmailEnabled: parseNotificationPreferences(
    row.notificationPreference,
  ).notifications.todoAssignment.email,
  executionFailureEmailEnabled: parseNotificationPreferences(
    row.notificationPreference,
  ).notifications.executionFailure.email,
})

/**
 * Service providing flow execution database operations.
 *
 * These are simple database operations without business logic.
 * Business logic belongs in the caller (e.g., the job handler).
 */
export class FlowExecutionOperations extends Context.Tag(
  "@pf/graphql-db-operations/FlowExecutionOperations",
)<
  FlowExecutionOperations,
  {
    /**
     * Query a flow by ID.
     * Returns null if not found.
     */
    readonly queryFlowById: (
      flowId: string,
    ) => Effect.Effect<FlowWithCondition | null, SqlError>

    /**
     * Get process state by process execution ID.
     * Returns raw state from database; callers should validate the state field.
     * Returns null if not found.
     */
    readonly getProcessStateByExecutionId: (
      processExecutionId: string,
    ) => Effect.Effect<ProcessStateRaw | null, SqlError>

    /**
     * Returns true when the process execution is still open for new work.
     */
    readonly isProcessExecutionOpen: (
      processExecutionId: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Load notification snapshot context for newly created todos.
     */
    readonly queryTodoNotificationInfo: (
      todoIds: readonly string[],
    ) => Effect.Effect<readonly TodoNotificationInfo[], SqlError>

    readonly insertToDo: (opts: {
      processExecutionId: string
      flowId: string
      assignedToProviderUserId?: string | null
      slaTargetAt?: DateTime.Utc | null
      slaWarningAt?: DateTime.Utc | null
      itemData?: Record<string, unknown> | unknown[] | null
      barrierScheduledFlowId?: string | null
    }) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    readonly insertToDos: (opts: {
      processExecutionId: string
      flowId: string
      items: ReadonlyArray<Record<string, unknown> | unknown[]>
      slaTargetAt?: DateTime.Utc | null
      slaWarningAt?: DateTime.Utc | null
      barrierScheduledFlowId?: string | null
    }) => Effect.Effect<readonly string[], SqlError, RequestTime | UserDetails>

    /**
     * Get SLA info for the target step of a given flow.
     * Used to calculate dueAt/dueWarningAt when creating todos.
     * Returns null if the flow or target step doesn't exist.
     */
    readonly getTargetStepSlaInfo: (flowId: string) => Effect.Effect<
      {
        slaValue: number | null
        slaUnit: string | null
        slaWarning: number | null
        orgUnitId: string
      } | null,
      SqlError
    >

    /**
     * Query all flows originating from a source step.
     * Returns flows with their condition info for batch processing.
     */
    readonly queryFlowsBySourceStepId: (
      sourceStepId: string,
    ) => Effect.Effect<readonly FlowWithCondition[], SqlError>

    /**
     * Count active (non-deleted) todos for a process execution.
     */
    readonly countActiveTodos: (
      processExecutionId: string,
    ) => Effect.Effect<number, SqlError>

    /**
     * Count pending jobs in a queue for a specific process execution.
     * Queries the job_queue table filtering by queue name and processExecutionId in payload.
     */
    readonly countPendingFlowJobs: (
      processExecutionId: string,
      queueName: string,
    ) => Effect.Effect<number, SqlError>

    readonly insertFlowDispatchJobs: (
      jobs: readonly NewFlowDispatchJob[],
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    readonly queryFlowDispatchJobs: (
      sourceScheduledFlowId: string,
    ) => Effect.Effect<readonly FlowDispatchJob[], SqlError>

    readonly queryFlowDispatchIdsByStorageQueue: (
      storageQueue: string,
      now: DateTime.Utc,
      limit: number,
    ) => Effect.Effect<readonly string[], SqlError>

    /** Lease all currently available rows for one ordered external dispatch. */
    readonly claimFlowDispatchJobs: (
      sourceScheduledFlowId: string,
      now: DateTime.Utc,
      lockedUntil: DateTime.Utc,
      receipt: string,
    ) => Effect.Effect<readonly FlowDispatchJob[], SqlError>

    /** Release the remaining rows owned by a failed dispatch drain. */
    readonly releaseFlowDispatchJobs: (
      sourceScheduledFlowId: string,
      receipt: string,
    ) => Effect.Effect<void, SqlError>

    readonly extendFlowDispatchClaim: (
      sourceScheduledFlowId: string,
      receipt: string,
      lockedUntil: DateTime.Utc,
    ) => Effect.Effect<boolean, SqlError>

    readonly deleteFlowDispatchJob: (
      id: string,
      receipt?: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Set the finishedAt timestamp and business duration on a process execution.
     * @param businessDurationMs - Elapsed business hours in milliseconds, or null if no calendar
     */
    readonly setProcessExecutionFinished: (
      processExecutionId: string,
      businessDurationMs: number | null,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Mark a process execution Failed: finished, not user-abandoned, with an
     * execution-level failure reason. Used for an unhandled terminal
     * system-step failure, including a Todo-less system-owned start step.
     */
    readonly setProcessExecutionFailed: (
      processExecutionId: string,
      failureReason: string,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Get the process ID for a given process execution.
     * Used to publish process events when execution finishes.
     * Returns null if not found.
     */
    readonly getProcessIdForExecution: (
      processExecutionId: string,
    ) => Effect.Effect<string | null, SqlError>

    /**
     * Get execution details needed to calculate business duration on completion.
     * Returns the execution start time (in epoch ms) and the process's org unit ID.
     * Returns null if not found.
     */
    readonly getExecutionDetailsForCompletion: (
      processExecutionId: string,
    ) => Effect.Effect<
      { createdAtMs: number; orgUnitId: string } | null,
      SqlError
    >

    /**
     * Check if the target step of a flow has a role.
     * System steps (SystemStep) have no role - role_id is NULL.
     * Returns true if the step has a role, false if it's a system step.
     * Returns null if the flow is not found.
     */
    readonly targetStepHasRole: (
      flowId: string,
    ) => Effect.Effect<boolean | null, SqlError>

    /**
     * Check if the target step of a flow has forEach semantics.
     * Returns true if has_for_each = true, false otherwise.
     * Returns null if the flow is not found.
     */
    readonly targetStepHasForEach: (
      flowId: string,
    ) => Effect.Effect<boolean | null, SqlError>

    /**
     * Count active (non-deleted) todos for a specific step within a process execution.
     * Used for forEach barrier check — flow continues only when all sibling todos complete.
     *
     * @param processExecutionId - The process execution ID
     * @param targetStepId - The step ID to count todos for
     */
    readonly countActiveTodosForStep: (
      processExecutionId: string,
      targetStepId: string,
    ) => Effect.Effect<number, SqlError>

    /**
     * Get the retry limit for a step by its path.
     * Returns null if the step is not found or has no retry limit set.
     * System steps can have a retry limit: 0 = no retries, 1+ = retry count.
     * When null, the system default retry limit should be used.
     *
     * @param stepPath - The step path (e.g., "finance/purchase-request/Manager approval")
     */
    readonly getStepRetryLimitByPath: (
      stepPath: string,
    ) => Effect.Effect<number | null, SqlError>

    /**
     * Look up a direct-assignee notification recipient by provider user ID.
     */
    readonly queryNotificationRecipientByProviderUserId: (
      providerUserId: string,
    ) => Effect.Effect<NotificationRecipientRow | null, SqlError>

    /**
     * Look up role-based notification recipients for a target role.
     */
    readonly queryNotificationRecipientsByRoleId: (
      roleId: string,
    ) => Effect.Effect<readonly NotificationRecipientRow[], SqlError>

    /**
     * Look up role-based notification recipients for an exact role path.
     */
    readonly queryNotificationRecipientsByRolePath: (
      rolePath: string,
    ) => Effect.Effect<readonly NotificationRecipientRow[], SqlError>
  }
>() {}
