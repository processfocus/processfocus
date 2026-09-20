import { Context, Data, Effect, Layer } from "effect"
import {
  ProcessCollectionQueries,
  type ProcessCollectionRow,
} from "@pf/graphql-db-operations"
import type {
  Process,
  ProcessInputPushRowT0NewDocumentStateT0,
} from "@pf/graphql-schema"
import type { RxDbCollectionOps } from "./collection-ops"

/**
 * Error thrown when attempting to modify Process documents from clients.
 * Process documents are server-managed and cannot be inserted, updated, or deleted by clients.
 */
class ProcessNotModifiableError extends Data.TaggedError(
  "ProcessNotModifiableError",
)<{
  readonly operation: "insert" | "update" | "delete"
}> {
  override get message() {
    return `Processes cannot be ${this.operation}ed by clients`
  }
}

/**
 * Formats a duration range from min/max milliseconds to a human-readable string.
 * Returns "Unknown" if no completed executions exist.
 */
export const formatDurationRange = (
  minMs: number | null,
  maxMs: number | null,
): string => {
  if (minMs === null || maxMs === null) {
    return "Unknown"
  }

  const formatValue = (ms: number): { value: number; unit: string } => {
    const hours = ms / (1000 * 60 * 60)
    const days = hours / 24
    const weeks = days / 7

    if (weeks >= 1) return { value: Math.round(weeks), unit: "week" }
    if (days >= 1) return { value: Math.round(days), unit: "day" }
    return { value: Math.round(hours) || 1, unit: "hour" }
  }

  const min = formatValue(minMs)
  const max = formatValue(maxMs)

  // If same unit and values, show single value
  if (min.unit === max.unit && min.value === max.value) {
    return `Typically ${min.value} ${min.unit}${min.value > 1 ? "s" : ""}`
  }

  // If same unit, show range
  if (min.unit === max.unit) {
    return `Typically ${min.value} - ${max.value} ${min.unit}s`
  }

  // Different units - show both
  return `Typically ${min.value} ${min.unit}${min.value > 1 ? "s" : ""} - ${max.value} ${max.unit}${max.value > 1 ? "s" : ""}`
}

/**
 * Maps a ProcessCollectionRow from the database to a Process GraphQL type.
 * Form field count is now read directly from the database.
 */
const mapRowToGraphql = (
  row: ProcessCollectionRow,
): Effect.Effect<Process, never, never> =>
  Effect.succeed({
    id: row.id,
    name: row.name,
    path: row.path,
    purpose: row.purpose,
    category: row.orgUnit.name,
    updatedAt: row.updatedAt,
    deleted: row.deleted,
    activeInstances: row.activeInstances,
    duration: formatDurationRange(row.minDurationMs, row.maxDurationMs),
    formFieldCount: row.formFieldCount,
    isFavorite: Math.random() > 0.7,
    orgUnit: {
      id: row.orgUnit.id,
      name: row.orgUnit.name,
      level: row.orgUnit.orgUnitLevel,
    },
    startStepPath: row.startStepPath,
  })

/**
 * RxDB collection operations for Process.
 *
 * This service adapts Process database queries to the generic
 * RxDbCollectionOps interface, enabling use with the generic resolvers.
 */
export class ProcessCollectionOps extends Context.Tag(
  "@pf/graphql-api/ProcessCollectionOps",
)<
  ProcessCollectionOps,
  RxDbCollectionOps<
    ProcessCollectionRow,
    Process,
    ProcessInputPushRowT0NewDocumentStateT0
  >
>() {}

/**
 * Live implementation that delegates to ProcessCollectionQueries.
 * Process documents are server-managed, so only pull is supported.
 */
export const ProcessCollectionOpsLive = Layer.effect(
  ProcessCollectionOps,
  Effect.gen(function* () {
    const queries = yield* ProcessCollectionQueries

    return {
      pull: queries.pullProcess,

      insert: () =>
        Effect.fail(new ProcessNotModifiableError({ operation: "insert" })),

      update: () =>
        Effect.fail(new ProcessNotModifiableError({ operation: "update" })),

      delete: () =>
        Effect.fail(new ProcessNotModifiableError({ operation: "delete" })),

      getByIds: queries.getProcesses,

      mapToGraphql: mapRowToGraphql,
    }
  }),
)
