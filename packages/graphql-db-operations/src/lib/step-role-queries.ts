import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Result from step role queries including startsProcess flag
 */
export interface StepRoleInfo {
  /** The role path for this step, or null if step doesn't exist */
  readonly rolePath: string | null
  /** Additional role paths that can also complete this step */
  readonly supportingRolePaths: readonly string[]
  readonly startsProcess: boolean
  readonly embedded: boolean
}

/**
 * Service providing step role query operations for authorization.
 */
export const collectRolePathsToTry = (stepRoleInfo: StepRoleInfo): string[] =>
  [stepRoleInfo.rolePath, ...(stepRoleInfo.supportingRolePaths ?? [])].filter(
    Boolean,
  ) as string[]

export class StepRoleQueries extends Context.Tag(
  "@pf/graphql-db-operations/StepRoleQueries",
)<
  StepRoleQueries,
  {
    /**
     * Query role path for a step by step path.
     * Returns the path of the role allowed to execute the step
     * and whether it's a start step.
     *
     * @param stepPath - The path of the step
     * @returns StepRoleInfo with role path and startsProcess flag
     */
    readonly queryRolePathsByStepPath: (
      stepPath: string,
    ) => Effect.Effect<StepRoleInfo, SqlError>

    /**
     * Query role paths for multiple steps by their paths.
     * Returns a map from step path to StepRoleInfo.
     *
     * @param stepPaths - Array of step paths to query
     * @returns Map from stepPath -> StepRoleInfo
     */
    readonly queryRolePathsByStepPaths: (
      stepPaths: string[],
    ) => Effect.Effect<Map<string, StepRoleInfo>, SqlError>

    /**
     * Look up a role ID by its path.
     * Returns the role id, or undefined if no matching non-deleted role exists.
     *
     * @param rolePath - The path of the role to look up
     * @returns The role id or undefined
     */
    readonly queryRoleIdByPath: (
      rolePath: string,
    ) => Effect.Effect<string | undefined, SqlError>
  }
>() {}
