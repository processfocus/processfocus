import { Data } from "effect"

/**
 * Error thrown when process state is not found for condition evaluation.
 */
export class ProcessStateNotFoundError extends Data.TaggedError(
  "ProcessStateNotFoundError",
)<{
  readonly processExecutionId: string
}> {}

/**
 * Error thrown when process execution details cannot be found.
 */
export class ProcessExecutionNotFoundError extends Data.TaggedError(
  "ProcessExecutionNotFoundError",
)<{
  readonly processExecutionId: string
}> {}

/**
 * Error thrown when process state cannot be parsed.
 */
export class InvalidProcessStateError extends Data.TaggedError(
  "InvalidProcessStateError",
)<{
  readonly processExecutionId: string
  readonly reason: string
}> {}

/**
 * Error thrown when a flow is not found in the database.
 */
export class FlowNotFoundError extends Data.TaggedError("FlowNotFoundError")<{
  readonly flowId: string
}> {}

/**
 * Error thrown when a scheduled flow is not found in the database.
 *
 * This is used for 2-phase commit emulation between the database and job queue.
 * When a job handler receives this error, it means the scheduled flow record
 * hasn't been committed yet (transaction still in progress) or the transaction
 * was rolled back. The job should be retried until the record becomes visible
 * or max attempts is reached.
 */
export class ScheduledFlowNotFoundError extends Data.TaggedError(
  "ScheduledFlowNotFoundError",
)<{
  readonly scheduledFlowId: string
}> {}

/**
 * Error thrown when an invalid SLA unit is encountered in the database.
 *
 * This indicates a data integrity issue - the sla_unit column contains
 * a value that is not one of the valid units (minutes, businessHours,
 * businessDays, businessWeeks).
 */
export class InvalidSlaUnitError extends Data.TaggedError(
  "InvalidSlaUnitError",
)<{
  readonly flowId: string
  readonly slaUnit: string
}> {}

/**
 * Error thrown when a schedule marker is invalid.
 *
 * This indicates a programming error - the schedule function returned
 * a marker with missing required fields (from date or offset).
 */
export class InvalidScheduleMarkerError extends Data.TaggedError(
  "InvalidScheduleMarkerError",
)<{
  readonly marker: unknown
  readonly reason: string
}> {}

/**
 * Error thrown when a job exceeds its retry budget.
 *
 * This happens when SQS delivers a message more times than the per-message
 * maxAttempts limit (which is advisory, not enforced by SQS). The queue's
 * redrive policy is the hard enforcement, which may deliver beyond our
 * intended retry limit.
 */
export class RetryBudgetExceededError extends Data.TaggedError(
  "RetryBudgetExceededError",
)<{
  readonly attempts: number
  readonly maxAttempts: number
  readonly queue: string
}> {}

export class DirectAssigneeResolutionError extends Data.TaggedError(
  "DirectAssigneeResolutionError",
)<{
  readonly stepPath: string
  readonly assignee: string
  readonly message: string
}> {}
