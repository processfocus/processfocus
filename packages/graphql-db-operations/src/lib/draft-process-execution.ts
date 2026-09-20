import type { SqlError } from "@effect/sql/SqlError"
import { Context, type DateTime, type Effect } from "effect"
import type { UpdateDeletedDocumentError } from "@pf/graphql-schema"
import type { RequestTime } from "@pf/request-time"
import type { ProcessState, StepNotFoundError } from "./process-execution"
import type { UserDetails } from "./user-details"

export interface PullCheckpoint {
  id: string
  updatedAt: number
}

export interface DraftProcessExecutionRow {
  id: string
  processId: string
  startStepId: string
  startedByUserId: string | null
  startedByEmail: string | null
  name: string
  startStepPath: string
  state: ProcessState
  lastSaved: DateTime.Utc
  updatedAt: number
  deleted: boolean
}

export interface DraftProcessExecutionMaster {
  id: string
  processId: string
  startStepPath: string
  state: ProcessState
  updatedAt: number
  deleted: boolean
}

/**
 * Service providing draft process execution query operations for RxDB replication.
 */
export class DraftProcessExecutionQueries extends Context.Tag(
  "@pf/graphql-db-operations/DraftProcessExecutionQueries",
)<
  DraftProcessExecutionQueries,
  {
    /**
     * Query draft process execution rows from database.
     *
     * @param checkpoint - Optional checkpoint to resume from. If null, returns all drafts.
     * @param limit - Maximum number of rows to return
     * @returns Raw rows from database
     */
    readonly pullDraftProcessExecution: (
      checkpoint: PullCheckpoint | null | undefined,
      limit: number,
    ) => Effect.Effect<DraftProcessExecutionRow[], SqlError, UserDetails>

    /**
     * Insert a new process execution state record with a client supplied id.
     * Returns processStateId.
     */
    readonly insertProcessState: (
      processStateId: string,
      processId: string,
      startStepPath: string,
      state: ProcessState,
    ) => Effect.Effect<
      string,
      SqlError | StepNotFoundError | UpdateDeletedDocumentError,
      RequestTime | UserDetails
    >

    /**
     * Update an existing process state record, including state and deleted flag.
     * Returns processStateId.
     */
    readonly updateProcessState: (
      processStateId: string,
      state: ProcessState,
      assumedMasterState: DraftProcessExecutionMaster,
    ) => Effect.Effect<
      string,
      SqlError | UpdateDeletedDocumentError,
      RequestTime | UserDetails
    >

    /**
     * Update an existing process state record, including state and deleted flag.
     * Returns processStateId.
     */
    readonly deleteProcessState: (
      processStateId: string,
      assumedMasterState: DraftProcessExecutionMaster,
    ) => Effect.Effect<
      string,
      SqlError | UpdateDeletedDocumentError,
      RequestTime | UserDetails
    >

    /**
     * Return the process states for the given `processStateIds`.
     */
    readonly getProcessStates: (
      processStateIds: string[],
    ) => Effect.Effect<DraftProcessExecutionRow[], SqlError, UserDetails>
  }
>() {}
