import { Context, Data, type DateTime, type Effect } from "effect"

export const AWS_COST_EXPLORER_COST_SOURCE = "aws-cost-explorer"
export const DEPLOY_CODEBUILD_COST_SOURCE = "deploy-codebuild"
export const TURSO_USAGE_COST_SOURCE = "turso-usage"

export type UsageCostSource =
  | typeof AWS_COST_EXPLORER_COST_SOURCE
  | typeof DEPLOY_CODEBUILD_COST_SOURCE
  | typeof TURSO_USAGE_COST_SOURCE

/**
 * Domain error for usage-cost service operations.
 * Live implementations map org/runtime-specific failures into this type so
 * `@pf/process` stays decoupled from DB layers. Requirements stay deferred
 * via the R channel where the implementation still needs ambient services.
 */
export class UsageCostError extends Data.TaggedError("UsageCostError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface RecordManualUsageCostInput {
  readonly projectId: string
  readonly environmentId: string
  readonly costSource?: UsageCostSource
  readonly costId: string
  readonly usageDate: DateTime.Utc
  readonly durationMs?: number
  readonly amount: number
  readonly costOther: Record<string, unknown>
}

export interface UpsertImportedUsageCostInput {
  readonly projectEnv: string
  readonly usageDate: DateTime.Utc
  readonly costCategory: string
  readonly costSource?: UsageCostSource
  readonly costId?: string
  readonly amount: number
  readonly costOther: Record<string, unknown>
}

export type ImportedUsageCostUpsertResult =
  | {
      readonly _tag: "Skipped"
      readonly projectEnv: string
      readonly reason: string
    }
  | {
      readonly _tag: "Upserted"
      readonly projectEnv: string
      readonly environmentId: string
      readonly costId: string
    }

export interface UsageCostServiceApi {
  readonly recordManualUsageCost: (
    input: RecordManualUsageCostInput,
  ) => Effect.Effect<void, UsageCostError, unknown>

  readonly upsertImportedUsageCosts: (
    inputs: ReadonlyArray<UpsertImportedUsageCostInput>,
  ) => Effect.Effect<
    ReadonlyArray<ImportedUsageCostUpsertResult>,
    UsageCostError,
    unknown
  >
}

export class UsageCostService extends Context.Tag(
  "@pf/process/UsageCostService",
)<UsageCostService, UsageCostServiceApi>() {}
