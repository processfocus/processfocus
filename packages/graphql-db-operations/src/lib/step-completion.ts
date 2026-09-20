import type { SqlError } from "@effect/sql/SqlError"
import type { DateTime } from "effect"
import { Context, Data, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { ProcessState } from "./process-execution"
import type { TodoRow } from "./todo-queries"
import type { UserDetails } from "./user-details"

/**
 * Tagged error for when a todo is not found by ID
 */
export class TodoNotFoundError extends Data.TaggedError("TodoNotFoundError")<{
  readonly todoId: string
}> {}

/**
 * Error thrown when process state in database has invalid format.
 *
 * This should only occur if the database was manually modified, as all
 * writes go through validated code paths.
 */
export class InvalidProcessStateError extends Data.TaggedError(
  "InvalidProcessStateError",
)<{
  readonly processStateId: string
  readonly message: string
}> {}

/**
 * Represents a todo with its target step information
 */
export interface TodoWithStepInfo {
  readonly createdBy?: string
  readonly id: string
  readonly processExecutionId: string
  readonly processStateId: string
  readonly startedByUserId: string | null
  readonly targetStepId: string
  readonly targetStepPath: string
  readonly processPath: string
  readonly orgUnitPath: string
  readonly assignedToProviderUserId: string | null
  readonly assignedToProviderUserEmail: string | null
  readonly correctionRequiredAt: DateTime.Utc | null
  /** When the todo was created (step started), in epoch milliseconds */
  readonly createdAtMs: number
  /** Org unit ID of the process (for calendar lookup) */
  readonly orgUnitId: string
  /** Parsed forEach item data (null for non-forEach steps) */
  readonly itemData: Record<string, unknown> | unknown[] | null
  /** Whether the target step uses forEach semantics */
  readonly hasForEach: boolean
  /** Barrier scheduled flow ID for forEach steps (null for non-forEach) */
  readonly barrierScheduledFlowId: string | null
}

export interface TodoForCompletion extends TodoWithStepInfo {
  readonly completed: boolean
}

export type PublicTodoStatus = "active" | "completed" | "unavailable"

export interface PublicTodoInfo {
  readonly todoId: string
  readonly status: PublicTodoStatus
  readonly stepPath: string | null
  readonly latestPublicCompletionInvitationRecipientEmail: string | null
  /** Parsed forEach item data (null for non-forEach steps) */
  readonly itemData: Record<string, unknown> | unknown[] | null
}

export interface PublicCompletionInvitationAttemptRef {
  readonly id: string
  readonly email: string
}

export interface CreatePublicCompletionInvitationAttemptInput {
  readonly todoId: string
  readonly recipientEmail: string
}

export interface PublicCompletionInvitationAttemptReceipt {
  readonly providerMessageId: string
  readonly providerSentTo: string
}

export type PublicCompletionInvitationDeliveryStatus = "delivered" | "failed"

export type PublicCompletionInvitationDeliveryFailureKind =
  | "recipient_address"
  | "provider_transport"

export interface PublicCompletionInvitationAttemptDeliveryEvent {
  readonly deliveryStatus: PublicCompletionInvitationDeliveryStatus
  readonly deliveryEventId: string
  readonly providerMessageId?: string
  readonly deliveryFailureKind?: PublicCompletionInvitationDeliveryFailureKind
  readonly deliveryFailureReason?: string
}

export interface PublicCompletionInvitationAttemptCallbackTarget {
  readonly attemptId: string
  readonly todoId: string
  readonly providerMessageId: string | null
  readonly providerSentTo: string | null
  readonly processExecutionId: string
  readonly assignedToProviderUserId: string | null
  readonly roleId: string | null
  readonly stepPath: string
  readonly stepName: string
  readonly processName: string
}

export interface PublicCompletionCorrectionRequiredInput {
  readonly todoId: string
  readonly invitationAttemptId: string
  readonly failureReason: string
}

export interface PublicCompletionCorrectionRecipient {
  readonly recipientEmail: string
  readonly failureReason: string | null
}

/**
 * Information about a failed todo for restart operations
 */
export interface FailedTodoInfo {
  readonly todoId: string
  readonly stepPath: string
  readonly isSystemStep: boolean // roleId IS NULL = system step
}

/**
 * Represents process state fetched for a todo
 */
export interface TodoProcessState {
  readonly processExecutionId: string
  readonly processStateId: string
  readonly state: ProcessState
  /** CAS token for replay-safe process-state updates. */
  readonly updatedAt: DateTime.Utc
  /** When the process execution was started (for FlowContext) */
  readonly processStartedAt: DateTime.DateTime
}

export type ProcessStateCasResult =
  | {
      readonly kind: "updated"
      readonly updatedAt: DateTime.Utc
    }
  | { readonly kind: "conflict" }

export interface TodoCompletionInput {
  readonly todoId: string
  readonly userId: string | null
  readonly businessDurationMs: number | null
  readonly externalParticipantId: string | null
  readonly completedByRoleId: string | null
}

export type TodoCompletionResult =
  | { readonly kind: "completed" }
  | { readonly kind: "already-completed" }
  | { readonly kind: "conflict" }
  | { readonly kind: "not-found" }

/**
 * Represents a todo with its associated process state.
 * Used for batch fetching process states for multiple todos.
 */
export interface TodoWithProcessState {
  readonly todoId: string
  readonly processExecutionId: string
  readonly processStateId: string
  readonly state: ProcessState
  readonly stepPath: string
  /** When the process execution was started (for FlowContext) */
  readonly processStartedAt: DateTime.DateTime
  /** Parsed forEach item data (null for non-forEach steps) */
  readonly itemData: Record<string, unknown> | unknown[] | null
}

/**
 * Raw data from database query for a completed step.
 * Used for building FlowContext in summary/condition callbacks.
 * Note: Provider user fields are always populated via COALESCE in the SQL query,
 * using user.sub as fallback for M2M/system users without provider user records.
 */
export interface CompletedStepData {
  stepPath: string
  userId: string
  userSub: string
  providerUserId: string
  providerUserName: string
  providerUserFirstName: string
  providerUserLastName: string
  providerUserEmail: string
  providerUserPicture: string
  completedAt: DateTime.DateTime
}

/**
 * Service providing step completion database operations.
 *
 * These are simple database operations without business logic.
 * Business logic belongs in the resolver.
 */
export class StepCompletionOperations extends Context.Tag(
  "@pf/graphql-db-operations/StepCompletionOperations",
)<
  StepCompletionOperations,
  {
    /**
     * Query a todo by ID with its target step information.
     * Returns null if not found.
     */
    readonly queryTodoById: (
      todoId: string,
    ) => Effect.Effect<TodoWithStepInfo | null, SqlError>

    /** Query completion context for either an open or completed todo. */
    readonly queryTodoForCompletionById: (
      todoId: string,
    ) => Effect.Effect<TodoForCompletion | null, SqlError>

    /**
     * Query todo availability for public todo UX. Completed status is returned
     * for soft-deleted todos, while missing/deleted process data returns unavailable.
     */
    readonly queryPublicTodoInfo: (
      todoId: string,
    ) => Effect.Effect<PublicTodoInfo, SqlError>

    /**
     * Look up the latest public-completion invitation attempt for a todo.
     * Returns null when no attempt exists.
     */
    readonly queryLatestPublicCompletionInvitationAttempt: (
      todoId: string,
    ) => Effect.Effect<PublicCompletionInvitationAttemptRef | null, SqlError>

    /**
     * Create a public completion invitation attempt before the invitation is
     * handed to the notification sender.
     */
    readonly createPublicCompletionInvitationAttempt: (
      input: CreatePublicCompletionInvitationAttemptInput,
    ) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    /**
     * Store provider delivery metadata returned by a callback-capable sender.
     * Returns false if the attempt no longer exists.
     */
    readonly recordPublicCompletionInvitationAttemptReceipt: (
      attemptId: string,
      receipt: PublicCompletionInvitationAttemptReceipt,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Look up the latest invitation attempt for a waiting Public Completion.
     * Returns null when the attempt is stale, the todo is completed/failed, or
     * the attempt no longer exists.
     */
    readonly queryPublicCompletionInvitationAttemptCallbackTarget: (
      todoId: string,
      attemptId: string,
    ) => Effect.Effect<
      PublicCompletionInvitationAttemptCallbackTarget | null,
      SqlError
    >

    /**
     * Persist provider callback delivery metadata for an invitation attempt.
     * This intentionally records the latest terminal provider state instead of
     * first-write-wins so a later terminal failure can supersede delivery.
     * Returns false if the attempt no longer exists.
     */
    readonly recordPublicCompletionInvitationAttemptDeliveryEvent: (
      attemptId: string,
      event: PublicCompletionInvitationAttemptDeliveryEvent,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Move a still-waiting Public Completion todo into Correction Required.
     * The todo remains active for internal provider-user work and is not failed.
     */
    readonly enterPublicCompletionCorrectionRequired: (
      input: PublicCompletionCorrectionRequiredInput,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Fetch the failed invitation recipient for a correction-required todo.
     * Returns null unless the todo is still in Correction Required and the
     * referenced invitation attempt is available.
     */
    readonly queryPublicCompletionCorrectionRecipient: (
      todoId: string,
    ) => Effect.Effect<PublicCompletionCorrectionRecipient | null, SqlError>

    /**
     * Clear Correction Required state after the process-state correction has
     * been applied and a new invitation attempt has been created.
     */
    readonly clearPublicCompletionCorrectionRequired: (
      todoId: string,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Update process state by deep merging data into the state JSON column.
     * Performs recursive merge to preserve nested object properties.
     * Example: {user: {name: "John", age: 30}} + {user: {age: 31}} = {user: {name: "John", age: 31}}
     */
    readonly updateProcessState: (
      processStateId: string,
      data: Record<string, unknown>,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Deep merge data only when the persisted updatedAt matches the caller's
     * snapshot. Returns the new token from the same write, or a conflict.
     */
    readonly updateProcessStateIfUnchanged: (
      processStateId: string,
      expectedUpdatedAt: DateTime.Utc,
      data: Record<string, unknown>,
    ) => Effect.Effect<
      ProcessStateCasResult,
      SqlError,
      RequestTime | UserDetails
    >

    /**
     * Append one item to a top-level process-state array key atomically.
     * Used by forEach system steps so concurrent async completions do not
     * overwrite sibling outputs.
     */
    readonly appendProcessStateArrayItem: (
      processStateId: string,
      stateKey: string,
      item: unknown,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /** Append only when the process-state snapshot is still current. */
    readonly appendProcessStateArrayItemIfUnchanged: (
      processStateId: string,
      expectedUpdatedAt: DateTime.Utc,
      stateKey: string,
      item: unknown,
    ) => Effect.Effect<
      ProcessStateCasResult,
      SqlError,
      RequestTime | UserDetails
    >

    /**
     * Complete a todo: set completedByUserId, businessDuration, and _deleted = true.
     * Returns the complete TodoRow with all joined data.
     * @param todoId - The todo to complete
     * @param userId - The user who completed the todo, or null for system-executed steps
     * @param businessDurationMs - Elapsed business hours for this step in milliseconds, or null
     * @param externalParticipantId - Optional external participant who completed it
     * @param completedByRoleId - Optional role that was used to complete the step
     */
    readonly completeToDo: (
      todoId: string,
      userId: string | null,
      businessDurationMs: number | null,
      externalParticipantId?: string,
      completedByRoleId?: string,
    ) => Effect.Effect<TodoRow, SqlError, RequestTime | UserDetails>

    /**
     * Complete an open todo once. Repeating the exact completion outcome is an
     * idempotent success; the first request's duration remains authoritative.
     * Missing or differently completed todos are explicit.
     */
    readonly completeToDoIfOpen: (
      input: TodoCompletionInput,
    ) => Effect.Effect<
      TodoCompletionResult,
      SqlError,
      RequestTime | UserDetails
    >

    /**
     * Atomically complete an async todo only if it is not already completed.
     * Clears any prior failure reason on successful recovery.
     *
     * Returns true when the todo transitioned to completed, false when it was
     * already completed and therefore left unchanged.
     */
    readonly completeAsyncToDo: (
      todoId: string,
      userId: string | null,
      businessDurationMs: number | null,
      completedByRoleId?: string,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Mark a todo as failed by recording the failure reason.
     * The todo remains active (_deleted = false).
     */
    readonly failToDo: (
      todoId: string,
      failureReason: string,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Atomically fail an async todo only if it is not already completed.
     *
     * Returns true when the todo was updated, false when it was already
     * completed and therefore left unchanged.
     */
    readonly failAsyncToDo: (
      todoId: string,
      failureReason: string,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Get process state for a given todo ID.
     * Returns null if the todo doesn't exist.
     * Returns InvalidProcessStateError if state has invalid format.
     */
    readonly getProcessStateByTodoId: (
      todoId: string,
    ) => Effect.Effect<
      TodoProcessState | null,
      SqlError | InvalidProcessStateError
    >

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

    /**
     * Set the finishedAt timestamp and business duration on a process execution.
     * @param businessDurationMs - Elapsed business hours in milliseconds, or null if no calendar
     */
    readonly setProcessExecutionFinished: (
      processExecutionId: string,
      businessDurationMs: number | null,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Batch fetch process states for multiple todo IDs.
     * Used for computing summaries efficiently during pullTodo.
     *
     * @param todoIds - Array of todo IDs to fetch process states for
     * @returns Map of todoId to TodoWithProcessState
     */
    readonly getProcessStatesByTodoIds: (
      todoIds: string[],
    ) => Effect.Effect<
      TodoWithProcessState[],
      SqlError | InvalidProcessStateError
    >

    /**
     * Get completed steps for a process execution with user/provider user info.
     * Used for building FlowContext to pass to summary/condition callbacks.
     *
     * @param processExecutionId - The process execution to query
     * @returns List of completed steps with user and provider user information
     */
    readonly getCompletedStepsForExecution: (
      processExecutionId: string,
    ) => Effect.Effect<CompletedStepData[], SqlError>

    /**
     * Query failed todos for a process execution.
     * Joins toDo→flow→step, filters _deleted = false AND failure_reason IS NOT NULL.
     *
     * @param executionId - The process execution ID
     * @returns List of failed todo info
     */
    readonly queryFailedTodosForExecution: (
      executionId: string,
    ) => Effect.Effect<FailedTodoInfo[], SqlError>

    /**
     * Clear failure_reason on given todos.
     *
     * @param todoIds - Array of todo IDs to clear failures for
     */
    readonly clearTodoFailures: (
      todoIds: string[],
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Clear finishedAt, businessDuration, and abandonedReason on a process
     * execution. This resets a completed or Failed run to "running" so restart
     * can re-enqueue the failed step. Does not clear abandonedAt.
     *
     * @param executionId - The process execution ID
     */
    readonly clearProcessExecutionFinished: (
      executionId: string,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Atomically reopen a Todo-less failed system-start execution.
     *
     * Clears finishedAt, businessDuration, and abandonedReason (the
     * execution-level failure representation) only when the row is currently a
     * system-start failure: finished, not user-abandoned, with a failure reason.
     * Does not clear abandonedAt.
     *
     * @returns true when this call reopened the execution (won the race)
     */
    readonly reopenFailedSystemStartExecution: (
      executionId: string,
    ) => Effect.Effect<boolean, SqlError, RequestTime | UserDetails>

    /**
     * Query active (non-deleted, non-failed) todo step paths for an execution.
     * Joins toDo -> flow -> step, filters _deleted = false AND failure_reason IS NULL.
     * Returns distinct step paths.
     *
     * @param executionId - The process execution ID
     * @returns Array of step paths
     */
    readonly queryActiveTodoStepPaths: (
      executionId: string,
    ) => Effect.Effect<string[], SqlError>

    /**
     * Set the abandonedAt and finishedAt timestamps on a process execution.
     * When `reason` is provided, records it as abandonedReason. When omitted,
     * leaves any existing abandonedReason unchanged so a Failed system-start's
     * failure text is not discarded.
     *
     * @param executionId - The process execution ID
     * @param reason - Optional reason for abandoning the execution
     */
    readonly setProcessExecutionAbandoned: (
      executionId: string,
      reason?: string,
    ) => Effect.Effect<void, SqlError, RequestTime | UserDetails>

    /**
     * Soft-delete all active todos for an execution.
     * Sets _deleted = true on all todos where _deleted = false.
     *
     * @param executionId - The process execution ID
     * @returns Array of deleted todo IDs
     */
    readonly softDeleteActiveTodosForExecution: (
      executionId: string,
    ) => Effect.Effect<string[], SqlError, RequestTime | UserDetails>
  }
>() {}
