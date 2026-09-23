import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { PullCheckpoint } from "./draft-process-execution"

/**
 * Raw todo row from database with step info.
 * Used to build the steps timeline.
 */
export interface TodoStepRow {
  /** Recoverable audit identity of the latest recorded action. */
  updatedBy?: string
  executionId: string
  todoId: string
  stepId: string
  stepName: string
  stepPath: string
  completed: boolean // from _deleted flag
  failureReason: string | null
  notStartedReason?: string | null
  correctionRequiredAt: number | null
  correctionFailureReason: string | null
  /** Durable user id that completed the todo (to_do.completed_by_user). */
  completedByUserId: string | null
  providerUserId: string | null
  providerUserFirstName: string | null
  providerUserLastName: string | null
  /** Completing Provider User email (via completed_by_user), not the assignee. */
  providerUserEmail: string | null
  providerUserPicture: string | null
  providerUserOrgUnit: string | null
  assignedProviderUserEmail: string | null
  externalParticipantId: string | null
  externalParticipantEmail: string | null
  roleId: string | null
  roleName: string | null
  roleOrgUnitPath: string | null // org unit path of the role (for authorization)
  completingRoleId: string | null // from to_do.completed_by_role
  completingRoleName: string | null
  completingRolePath: string | null
  itemData: Record<string, unknown> | unknown[] | null
  createdAt: number // epoch ms (todo creation time = step started)
  updatedAt: number // epoch ms (todo completion time for completed steps)
}

/**
 * Raw execution row from database.
 * Does not include steps - those are assembled separately using todos + org graph.
 */
export interface ExecutionRow {
  readonly withoutWaiting?: boolean
  /** Immutable audit identity at execution initiation. */
  createdBy?: string
  id: string
  processStateId: string
  processName: string
  processPath: string
  status: string
  startedAt: string // ISO date-time string (process_execution.created_at)
  finishedAt: string | null // ISO date-time string
  durationMs: number | null
  updatedAt: number // Keep as epoch ms for RxDB checkpoint
  deleted: boolean
  // Start step info (from process_state)
  startStepId: string
  systemStartCompleted?: boolean
  startStepName: string
  startStepPath: string
  startedByRoleId: string | null // from process_state.started_by_role
  startedByRoleName: string | null
  startedByRolePath: string | null
  startStepRoleId: string | null
  startStepRoleName: string | null
  startStepRoleOrgUnitPath: string | null // org unit path of the start step's role
  startStepEmbedded: boolean
  startStepExternalParticipantId: string | null
  startStepExternalParticipantEmail: string | null
  // Timestamps for the start step
  processStateCreatedAt: string // ISO date-time string (process_state.created_at = start step started)
  // Who started the process (from process_state.started_by_user -> provider_user)
  startedByEmail: string | null // user.email - used for authorization checks
  startedById: string | null // provider user id
  startedByFirstName: string | null
  startedByLastName: string | null
  startedByPicture: string | null
  startedByOrgUnit: string | null
  abandonedReason: string | null
  notStartedReason?: string | null
  // SLA info from process
  processSlaValue: number | null
  processSlaUnit: string | null
  processSlaWarning: number | null
  // Duration stats from CTE
  typicalDurationMinMs: number | null
  typicalDurationMaxMs: number | null
  // Process org unit for SLA calculation
  processOrgUnitId: string
}

export interface ExecutionListQuery {
  readonly offset: number
  readonly limit: number
  readonly processPath?: string | null | undefined
}

/**
 * Service providing execution query operations for RxDB replication.
 */
export class ExecutionQueries extends Context.Tag(
  "@pf/graphql-db-operations/ExecutionQueries",
)<
  ExecutionQueries,
  {
    /**
     * Query execution rows from database for RxDB replication.
     *
     * @param checkpoint - Optional checkpoint to resume from. If null, returns all executions.
     * @param historySince - Retain the terminal history floor while paging through old Running rows.
     * @param includeRunning - Include Running rows before the initial history checkpoint; omit when resuming.
     * @param limit - Maximum number of rows to return
     * @returns Raw rows from database (without steps)
     */
    readonly pullExecution: (
      checkpoint: PullCheckpoint | null | undefined,
      limit: number,
      includeRunning?: boolean,
      historySince?: number,
    ) => Effect.Effect<ExecutionRow[], SqlError>

    /**
     * Return the executions for the given ids.
     */
    readonly getExecutions: (
      ids: string[],
    ) => Effect.Effect<ExecutionRow[], SqlError>

    /**
     * Query a stable, filtered window for the organisation-runtime Execution
     * list. Cedar authorization and public paging are applied by GraphQL.
     */
    readonly listExecutions: (
      query: ExecutionListQuery,
    ) => Effect.Effect<ExecutionRow[], SqlError>

    /**
     * Query todos with step info for a batch of execution IDs.
     * Returns raw todo rows - caller assembles the steps timeline.
     */
    readonly getTodosForExecutions: (
      executionIds: string[],
    ) => Effect.Effect<TodoStepRow[], SqlError>

    /**
     * Get the process state JSON for an execution.
     * Joins process_execution to process_state and returns the state data.
     * Returns null if execution not found.
     */
    readonly getProcessStateByExecutionId: (
      executionId: string,
    ) => Effect.Effect<Record<string, unknown> | null, SqlError>
  }
>() {}
