import { Context, Data, Effect } from "effect"
import type DirectedGraph from "graphology"
import type { FlowContext, StepMeta } from "./flow-context"
import { toConstructPath } from "./org-utils"
import type { Organisation } from "./organisation"
import type { GraphEdge, GraphNode } from "./process"

/**
 * Error thrown when the source step cannot be found in the organisation.
 */
export class SourceStepNotFoundError extends Data.TaggedError(
  "SourceStepNotFoundError",
)<{
  readonly sourceStepPath: string
}> {}

/**
 * Error thrown when the edge between source and target steps cannot be found.
 */
export class EdgeNotFoundError extends Data.TaggedError("EdgeNotFoundError")<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
}> {}

/**
 * Error thrown when a flow has a condition in the database but no condition function
 * exists in the organisation code.
 */
export class ConditionFunctionMissingError extends Data.TaggedError(
  "ConditionFunctionMissingError",
)<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
  readonly conditionText: string
}> {}

/**
 * Error thrown when a condition function throws an exception during evaluation.
 */
export class ConditionEvaluationError extends Data.TaggedError(
  "ConditionEvaluationError",
)<{
  readonly sourceStepPath: string
  readonly targetStepPath: string
  readonly error: string
}> {}

/**
 * Service interface for evaluating flow conditions.
 */
export interface ConditionEvaluatorService {
  /**
   * Evaluate a flow condition against process state.
   *
   * This should only be called when the database indicates a condition exists.
   * If the org code doesn't have a matching condition function, throws
   * ConditionFunctionMissingError (indicates org code is out of sync with database).
   *
   * @param sourceStepPath - Path of the source step
   * @param targetStepPath - Path of the target step
   * @param state - Current process state
   * @param ctx - Optional flow context with completed step metadata
   * @returns true if condition is satisfied, false otherwise
   */
  readonly evaluate: (
    sourceStepPath: string,
    targetStepPath: string,
    state: Record<string, unknown>,
    ctx?: FlowContext<Record<string, StepMeta>>,
  ) => Effect.Effect<
    boolean,
    | SourceStepNotFoundError
    | EdgeNotFoundError
    | ConditionFunctionMissingError
    | ConditionEvaluationError
  >
}

/**
 * Context tag for the ConditionEvaluator service.
 */
export class ConditionEvaluator extends Context.Tag(
  "@pf/process/ConditionEvaluator",
)<ConditionEvaluator, ConditionEvaluatorService>() {}

/**
 * Create a ConditionEvaluator service from an Organisation.
 *
 * @param org - The organisation containing process definitions
 * @returns A ConditionEvaluatorService implementation
 */
export const makeConditionEvaluator = (
  org: Organisation,
): ConditionEvaluatorService => ({
  evaluate: (sourceStepPath, targetStepPath, state, ctx) =>
    Effect.gen(function* () {
      // Find the source step to access its process
      // stepByPath handles paths with or without leading slash
      const sourceStep = org.stepByPath(sourceStepPath)
      if (!sourceStep) {
        return yield* new SourceStepNotFoundError({ sourceStepPath })
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
      // normal edge to the same target. Condition evaluation only applies to
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
        return yield* new EdgeNotFoundError({ sourceStepPath, targetStepPath })
      }

      // Get the edge attributes which contain the condition function
      const edgeAttributes = graph.getEdgeAttributes(edge)
      const conditionFn = edgeAttributes.condition

      // If no condition function exists but this method was called, there's a mismatch
      // between the database (which has a condition) and the org code (which doesn't)
      if (!conditionFn) {
        return yield* new ConditionFunctionMissingError({
          sourceStepPath,
          targetStepPath,
          conditionText: "unknown", // The actual text is only known by the caller
        })
      }

      // Evaluate the condition function against the state
      // Cast ctx to match the condition function's expected type
      // (generic type info is erased at runtime but values are compatible)
      const result = yield* Effect.try({
        try: () =>
          conditionFn(
            state,
            ctx as FlowContext<Record<string, never>> | undefined,
          ),
        catch: (error) =>
          new ConditionEvaluationError({
            sourceStepPath,
            targetStepPath,
            error: error instanceof Error ? error.message : String(error),
          }),
      })

      return result
    }),
})
