import {
  Context,
  Data,
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaAST,
} from "effect"
import type DirectedGraph from "graphology"
import type { FlowContext, StepMeta } from "./flow-context"
import { toConstructPath } from "./org-utils"
import type { Organisation } from "./organisation"
import type { GraphEdge, GraphNode } from "./process"
import { Schedule, type ScheduledTime } from "./schedule"

/**
 * Error thrown when the source step cannot be found in the organisation.
 */
export class SourceStepNotFoundForScheduleError extends Data.TaggedError(
  "SourceStepNotFoundForScheduleError",
)<{
  readonly sourceStepPath: string
}> {}

/**
 * Error thrown when the edge between source and target steps cannot be found.
 */
export class EdgeNotFoundForScheduleError extends Data.TaggedError(
  "EdgeNotFoundForScheduleError",
)<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
}> {}

/**
 * Error thrown when a flow has a schedule in the database but no schedule function
 * exists in the organisation code.
 */
export class ScheduleFunctionMissingError extends Data.TaggedError(
  "ScheduleFunctionMissingError",
)<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
  readonly scheduleText: string
}> {}

/**
 * Error thrown when a schedule function throws an exception during evaluation.
 */
export class ScheduleEvaluationError extends Data.TaggedError(
  "ScheduleEvaluationError",
)<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
  readonly message: string
  readonly stack?: string
  readonly cause?: unknown
}> {}

/**
 * Service interface for evaluating flow schedules.
 */
export interface ScheduleEvaluatorService {
  /**
   * Evaluate a flow schedule against process state.
   *
   * This should only be called when the database indicates a schedule exists.
   * If the org code doesn't have a matching schedule function, throws
   * ScheduleFunctionMissingError (indicates org code is out of sync with database).
   *
   * @param sourceStepPath - Path of the source step
   * @param targetStepPath - Path of the target step
   * @param state - Current process state
   * @param ctx - Flow context with completed step metadata (e.g., completedAt times)
   * @returns DateTime indicating when the transition should trigger
   */
  readonly evaluate: (
    sourceStepPath: string,
    targetStepPath: string,
    state: Record<string, unknown>,
    ctx: FlowContext<Record<string, StepMeta>>,
  ) => Effect.Effect<
    ScheduledTime,
    | SourceStepNotFoundForScheduleError
    | EdgeNotFoundForScheduleError
    | ScheduleFunctionMissingError
    | ScheduleEvaluationError
  >
}

/**
 * Context tag for the ScheduleEvaluator service.
 */
export class ScheduleEvaluator extends Context.Tag(
  "@pf/process/ScheduleEvaluator",
)<ScheduleEvaluator, ScheduleEvaluatorService>() {}

/**
 * Create a ScheduleEvaluator service from an Organisation.
 *
 * @param org - The organisation containing process definitions
 * @returns A ScheduleEvaluatorService implementation
 */
export const makeScheduleEvaluator = (
  org: Organisation,
): ScheduleEvaluatorService => ({
  evaluate: (
    sourceStepPath,
    targetStepPath,
    state,
    ctx: FlowContext<Record<string, StepMeta>>,
  ) =>
    Effect.gen(function* () {
      // Find the source step to access its process
      // stepByPath handles paths with or without leading slash
      const sourceStep = org.stepByPath(sourceStepPath)
      if (!sourceStep) {
        return yield* new SourceStepNotFoundForScheduleError({ sourceStepPath })
      }

      // Get the process graph
      const graph = sourceStep.process.getGraph() as DirectedGraph<
        GraphNode,
        GraphEdge
      >

      // Convert paths to construct format (no leading slash) for graph lookup
      // DB paths have leading slashes, but graph nodes use construct paths
      const sourceConstructPath = toConstructPath(sourceStepPath)
      const targetConstructPath = toConstructPath(targetStepPath)

      // The process graph is a multigraph so onError edges can coexist with a
      // normal edge to the same target. Schedule evaluation only applies to
      // the normal flow edge.
      const edge = (graph.outEdges(sourceConstructPath) ?? []).find(
        (candidate) => {
          if (graph.target(candidate) !== targetConstructPath) {
            return false
          }

          const attrs = graph.getEdgeAttributes(candidate)
          return attrs.isOnError !== true
        },
      )
      if (!edge) {
        return yield* new EdgeNotFoundForScheduleError({
          sourceStepPath,
          targetStepPath,
        })
      }

      // Get the edge attributes which contain the schedule function
      const edgeAttributes = graph.getEdgeAttributes(edge)
      const scheduleFn = edgeAttributes.schedule

      // If no schedule function exists but this method was called, there's a mismatch
      // between the database (which has a schedule) and the org code (which doesn't)
      if (!scheduleFn) {
        return yield* new ScheduleFunctionMissingError({
          sourceStepPath,
          targetStepPath,
          scheduleText: "unknown", // The actual text is only known by the caller
        })
      }

      // JSON persistence encodes authored DateTime fields as strings. Rehydrate
      // dates by their schema before invoking schedules (including DateTime.add).
      // Schedule evaluation is pure; it must not execute service-dependent form
      // transformations merely to read a business date.
      const decodedState = { ...state }
      for (const { path } of sourceStep.process.forms()) {
        const form = org.stepByPath(path)
        for (const [field, schema] of Object.entries(form?.output ?? {})) {
          if (
            !Schema.isSchema(schema) ||
            DateTime.isDateTime(decodedState[field]) ||
            decodedState[field] == null
          )
            continue
          const type = SchemaAST.typeAST(schema.ast)
          if (
            !Option.contains(
              SchemaAST.getIdentifierAnnotation(type),
              "DateTimeUtcFromSelf",
            )
          )
            continue
          decodedState[field] = yield* Schema.decodeUnknown(Schema.DateTimeUtc)(
            decodedState[field],
          ).pipe(
            Effect.mapError(
              () =>
                new ScheduleEvaluationError({
                  sourceStepPath,
                  targetStepPath,
                  message: `Invalid persisted date for ${field}`,
                }),
            ),
          )
        }
      }
      const result = yield* Effect.try({
        try: () =>
          scheduleFn(decodedState, ctx as FlowContext<Record<string, never>>),
        catch: (error) => {
          const isError = error instanceof Error
          return new ScheduleEvaluationError({
            sourceStepPath,
            targetStepPath,
            message: isError ? error.message : String(error),
            ...(isError && error.stack ? { stack: error.stack } : {}),
            cause: error,
          })
        },
      })

      if (
        !Schedule.isScheduleMarker(result) &&
        (!DateTime.isDateTime(result) ||
          !Number.isFinite(DateTime.toEpochMillis(result)))
      ) {
        return yield* new ScheduleEvaluationError({
          sourceStepPath,
          targetStepPath,
          message: "Schedule did not return a valid date or schedule marker",
        })
      }
      return result
    }),
})
