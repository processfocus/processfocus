import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, type Effect } from "effect"

/**
 * Error thrown when a process lookup by path fails to find a matching record.
 */
export class ProcessNotFoundError extends Data.TaggedError(
  "ProcessNotFoundError",
)<{
  readonly path: string
  readonly message: string
}> {}

/**
 * Database row type for a workflow step with optional role and phase information.
 * Role fields are null for SystemSteps (system-executed steps without a role).
 */
export interface WorkflowStepRow {
  id: string
  name: string
  path: string
  purpose: string
  processId: string
  roleId: string | null
  roleName: string | null
  rolePath: string | null
  phaseId: string | null
  phaseName: string | null
  phasePath: string | null
  phaseOrder: number | null
  isStartStep: boolean
  isEmbedded: boolean
}

/**
 * Database row type for a workflow flow (connection between steps).
 */
export interface WorkflowFlowRow {
  id: string
  sourceStepId: string
  targetStepId: string
  condition: string | null
  isElse: boolean
  isOnError: boolean
  taggedErrors: readonly string[] | null
  schedule: string | null
}

/**
 * Database row type for a role responsibility in a process.
 */
export interface WorkflowResponsibilityRow {
  roleId: string
  roleName: string
  rolePath: string
  responsibility: string
  /** 1-based display order within the process, or null if not specified */
  order: number | null
}

/**
 * Complete workflow data including steps, flows, and responsibilities.
 */
export interface WorkflowData {
  processId: string
  processName: string
  processPath: string
  processPurpose: string
  steps: WorkflowStepRow[]
  flows: WorkflowFlowRow[]
  responsibilities: WorkflowResponsibilityRow[]
}

/**
 * Service providing workflow query operations.
 */
export class WorkflowQueries extends Context.Tag(
  "@pf/graphql-db-operations/WorkflowQueries",
)<
  WorkflowQueries,
  {
    /**
     * Query workflow data by process path.
     * Returns process, all its steps with role information, and all flows.
     *
     * @param processPath - Path of the process to query
     * @returns Workflow data or error if process not found
     */
    readonly queryWorkflowByProcessPath: (
      processPath: string,
    ) => Effect.Effect<WorkflowData, SqlError | ProcessNotFoundError>
  }
>() {}
