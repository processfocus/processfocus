import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

export interface OrgUnitRow {
  id: string
  name: string
  acronym: string | null
  startDayOfWeek: number | null
  orgUnitLevel: string
  parentOrgUnitId: string | null
  path: string
}

export interface ProcessRow {
  id: string
  orgUnitId: string
  name: string
  path: string
  purpose: string
}

export interface Role {
  id: string
  orgUnitId: string
  name: string
  path: string
}

export interface OrgLevelWithDepth {
  readonly level: string
  readonly maxDepth: number
}

/**
 * Service providing organization query operations.
 */
export class OrgQueries extends Context.Tag(
  "@pf/graphql-db-operations/OrgQueries",
)<
  OrgQueries,
  {
    /**
     * Query the root organisation unit (where parentOrgUnitId is null).
     */
    readonly queryRoot: Effect.Effect<OrgUnitRow | null, SqlError>
    /**
     * Query child organisation units for a given parent.
     */
    readonly queryChildren: (
      parentId: string,
    ) => Effect.Effect<OrgUnitRow[], SqlError>
    /**
     * Query processes for a given organisation unit.
     */
    readonly queryProcesses: (
      orgUnitId: string,
    ) => Effect.Effect<ProcessRow[], SqlError>
    /**
     * Query roles for a given organisation unit.
     */
    readonly queryRoles: (orgUnitId: string) => Effect.Effect<Role[], SqlError>
    /**
     * Query all organisation unit levels with their maximum depth.
     * Results are sorted by maxDepth ascending.
     */
    readonly queryOrgLevels: Effect.Effect<OrgLevelWithDepth[], SqlError>
  }
>() {}
