import { Console, Data, Effect } from "effect"
import type { Organisation } from "@pf/process"

/**
 * Error thrown when organisation has flow validation errors.
 */
class FlowValidationError extends Data.TaggedError("FlowValidationError")<{
  readonly flowErrors: Array<{
    processPath: string
    unreachable: string[]
    dangling: string[]
    missingElse: string[]
    multipleElse: string[]
    orphanElse: string[]
  }>
}> {}

/**
 * Error thrown when steps have conditional flows without an else branch.
 */
class MissingElseBranchError extends Data.TaggedError(
  "MissingElseBranchError",
)<{
  readonly steps: Array<{ processPath: string; stepPath: string }>
}> {}

/**
 * Error thrown when steps have multiple else branches.
 */
class MultipleElseBranchError extends Data.TaggedError(
  "MultipleElseBranchError",
)<{
  readonly steps: Array<{ processPath: string; stepPath: string }>
}> {}

/**
 * Error thrown when a process has multiple start nodes.
 */
class MultipleStartNodesError extends Data.TaggedError(
  "MultipleStartNodesError",
)<{
  readonly processPath: string
  readonly startNodeCount: number
}> {}

/**
 * Validates all process flows in an organisation.
 * Checks for:
 * - Unreachable steps (not connected to start)
 * - Dangling steps (missing .end() calls)
 * - Missing else branches (conditional flows without else)
 * - Multiple else branches (more than one else edge)
 * - Multiple start nodes (not yet supported in UI)
 *
 * Logs detailed error messages before failing.
 */
export const validateFlows = (
  org: Organisation,
): Effect.Effect<
  void,
  | FlowValidationError
  | MultipleStartNodesError
  | MissingElseBranchError
  | MultipleElseBranchError
> =>
  Effect.gen(function* () {
    // Check for flow errors
    const flowErrors = org.validateAllFlows()
    if (flowErrors.length > 0) {
      yield* Console.error("\n❌ Flow Validation Error:")
      for (const err of flowErrors) {
        yield* Console.error(`   Process: ${err.processPath}`)
        if (err.unreachable.length > 0) {
          yield* Console.error(`   Unreachable steps (not connected to start):`)
          for (const step of err.unreachable) {
            yield* Console.error(`     - ${step}`)
          }
        }
        if (err.dangling.length > 0) {
          yield* Console.error(`   Dangling steps (missing .end()):`)
          for (const step of err.dangling) {
            yield* Console.error(`     - ${step}`)
          }
        }
        if (err.missingElse.length > 0) {
          yield* Console.error(
            `   Missing else branch (conditional flow without .else()):`,
          )
          for (const step of err.missingElse) {
            yield* Console.error(`     - ${step}`)
          }
        }
        if (err.multipleElse.length > 0) {
          yield* Console.error(`   Multiple else branches (only one allowed):`)
          for (const step of err.multipleElse) {
            yield* Console.error(`     - ${step}`)
          }
        }
        if (err.orphanElse.length > 0) {
          yield* Console.error(
            `   Orphan else branch (else without conditional flow):`,
          )
          for (const step of err.orphanElse) {
            yield* Console.error(`     - ${step}`)
          }
        }
      }
      yield* Console.error(
        `   Tip: Ensure all steps are connected via process.start() and call .end() on terminal steps`,
      )
      yield* Console.error(
        `   Tip: Steps with conditional flows must have exactly one .else() or .elseEnd() branch`,
      )
      yield* Console.error(
        `   Tip: An else branch requires at least one conditional flow from the same step`,
      )
      return yield* new FlowValidationError({ flowErrors })
    }

    // Check for multiple start nodes
    for (const process of org.processes()) {
      const startNodes = process.startNodes()
      if (startNodes.length > 1) {
        yield* Console.error("\n❌ Multiple Start Nodes Error:")
        yield* Console.error(`   Process: ${process.node.path}`)
        yield* Console.error(
          `   Found ${startNodes.length} start nodes, but only 1 is supported`,
        )
        yield* Console.error(`   Start nodes:`)
        for (const node of startNodes) {
          yield* Console.error(`     - ${node.node.path}`)
        }
        return yield* new MultipleStartNodesError({
          processPath: process.node.path,
          startNodeCount: startNodes.length,
        })
      }
    }
  })
