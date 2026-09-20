import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { PullCheckpoint } from "./draft-process-execution"

export interface DbProcess {
  id: string
  name: string
  path: string
  orgUnitId: string
  purpose: string
  orgUnit: {
    id: string
    name: string
    orgUnitLevel: string
  }
}

export interface ProcessListRow {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly category: string
  readonly purpose: string
  readonly startStepPath: string
  readonly activeInstances: number
}

export interface ProcessListQuery {
  readonly offset: number
  readonly limit: number
  readonly processPath?: string | null | undefined
}

/**
 * Service providing process query operations.
 */
export class ProcessQueries extends Context.Tag(
  "@pf/graphql-db-operations/ProcessQueries",
)<
  ProcessQueries,
  {
    /**
     * Query all processes with their organization unit.
     */
    readonly queryAllProcesses: Effect.Effect<DbProcess[], SqlError>

    /**
     * Query a stable, filtered window of startable Process catalog rows.
     * Cedar authorization is applied by the GraphQL layer before public paging.
     */
    readonly listProcesses: (
      query: ProcessListQuery,
    ) => Effect.Effect<ProcessListRow[], SqlError>
  }
>() {}

/**
 * Database row type for Process collection in RxDB replication.
 */
export interface ProcessCollectionRow {
  id: string
  name: string
  path: string
  purpose: string
  updatedAt: number
  deleted: boolean
  orgUnit: {
    id: string
    name: string
    orgUnitLevel: string
  }
  startStepPath: string
  /** Number of form fields in the start step (0 if not a form) */
  formFieldCount: number
  /** Number of active process executions (with pending to-dos) */
  activeInstances: number
  /** Minimum duration in milliseconds for completed process executions */
  minDurationMs: number | null
  /** Maximum duration in milliseconds for completed process executions */
  maxDurationMs: number | null
}

/**
 * Service providing Process collection operations for RxDB replication.
 * Pull-only for now as Process documents are server-managed.
 */
export class ProcessCollectionQueries extends Context.Tag(
  "@pf/graphql-db-operations/ProcessCollectionQueries",
)<
  ProcessCollectionQueries,
  {
    /**
     * Pull processes from database for RxDB replication.
     *
     * @param checkpoint - Optional checkpoint to resume from
     * @param limit - Maximum number of rows to return
     * @returns Raw rows from database
     */
    readonly pullProcess: (
      checkpoint: PullCheckpoint | null | undefined,
      limit: number,
    ) => Effect.Effect<ProcessCollectionRow[], SqlError>

    /**
     * Get processes by their IDs.
     *
     * @param ids - Process IDs to fetch
     */
    readonly getProcesses: (
      ids: string[],
    ) => Effect.Effect<ProcessCollectionRow[], SqlError>
  }
>() {}
