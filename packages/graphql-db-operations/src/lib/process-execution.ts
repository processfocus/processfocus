import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { UserDetails } from "./user-details"

/**
 * Error thrown when a step lookup by path fails to find a matching record.
 *
 * This occurs when inserting a process state with a start step path
 * that does not exist in the database.
 */
export class StepNotFoundError extends Data.TaggedError("StepNotFoundError")<{
  readonly path: string
  readonly message: string
}> {}

export type ProcessState = Record<string, unknown>

export interface ProcessExecutionStartInfo {
  readonly executionId: string
  readonly withoutWaiting?: boolean
  readonly processId: string
  readonly stepId: string
  readonly startStepPath: string
  readonly state: ProcessState
}

/**
 * Service providing process execution operations.
 */
export class ProcessExecutionOperations extends Context.Tag(
  "@pf/graphql-db-operations/ProcessExecutionOperations",
)<
  ProcessExecutionOperations,
  {
    /**
     * Insert a new process execution state record.
     * Returns the generated processStateId and the step ID.
     */
    readonly insertProcessState: (
      processId: string,
      startStepPath: string,
      state: ProcessState,
      startedByExternalParticipantId?: string,
      startedByRoleId?: string,
    ) => Effect.Effect<
      { processStateId: string; stepId: string },
      SqlError | StepNotFoundError,
      RequestTime | UserDetails
    >

    /**
     * Insert a new process execution record.
     * Returns the persisted executionId.
     */
    readonly insertProcessExecution: (
      processStateId: string,
      executionId?: string,
      withoutWaiting?: boolean,
    ) => Effect.Effect<string, SqlError, RequestTime | UserDetails>

    /**
     * Load the persisted start details for an execution.
     * Returns null when the execution does not exist.
     */
    readonly getProcessExecutionStartInfo: (
      executionId: string,
    ) => Effect.Effect<ProcessExecutionStartInfo | null, SqlError>
  }
>() {}
