import { Context, Data, Effect, type Schema } from "effect"
import type { FlowContext, FormStepMeta, StepMeta } from "./flow-context"
import type { Form } from "./form"
import type { Organisation } from "./organisation"
import {
  type AuthorTaggedError,
  NotAForEachStepError,
  type SystemStep,
} from "./system-step"

// NotAForEachStepError is defined/exported from system-step only so the package
// barrel (`export *` of both modules) does not conflict (TS2308).

/**
 * Error thrown when the target step cannot be found in the organisation.
 */
export class ForEachStepNotFoundError extends Data.TaggedError(
  "ForEachStepNotFoundError",
)<{
  readonly stepPath: string
}> {}

/**
 * Error thrown when the forEach items resolution fails.
 */
export class ForEachItemsError extends Data.TaggedError("ForEachItemsError")<{
  readonly stepPath: string
  readonly error: AuthorTaggedError | NotAForEachStepError
}> {}

/**
 * All possible errors from forEach items resolution.
 */
export type ForEachItemsResolverError =
  | ForEachStepNotFoundError
  | NotAForEachStepError
  | ForEachItemsError

/**
 * Service interface for resolving forEach items from a step.
 */
export interface ForEachItemsResolverService {
  /**
   * Resolve the forEach items for a step.
   *
   * @param stepPath - Path of the forEach step
   * @param state - Current process state
   * @param ctx - Flow context with completed step metadata
   * @returns Array of items (each item is the input for one todo)
   */
  readonly resolve: (
    stepPath: string,
    state: Record<string, unknown>,
    ctx: FlowContext<Record<string, StepMeta>>,
  ) => Effect.Effect<ReadonlyArray<unknown>, ForEachItemsResolverError, unknown>
}

/**
 * Context tag for the ForEachItemsResolver service.
 */
export class ForEachItemsResolver extends Context.Tag(
  "@pf/process/ForEachItemsResolver",
)<ForEachItemsResolver, ForEachItemsResolverService>() {}

/**
 * Create a ForEachItemsResolver service from an Organisation.
 *
 * @param org - The organisation containing process definitions
 * @returns A ForEachItemsResolverService implementation
 */
export const makeForEachItemsResolver = (
  org: Organisation,
): ForEachItemsResolverService => ({
  resolve: (stepPath, state, ctx) => {
    const effect = Effect.gen(function* () {
      // Find the step by path
      const step = org.stepByPath(stepPath)
      if (!step) {
        return yield* new ForEachStepNotFoundError({ stepPath })
      }

      // Verify step has forEach
      if (!step.hasForEach) {
        return yield* new NotAForEachStepError({ stepPath })
      }

      // Resolve items from either SystemStep or Form
      if (step.isSystemStep) {
        // Cast to SystemStep (safe: checked isSystemStep + hasForEach)
        // biome-ignore lint/suspicious/noExplicitAny: Type erasure at runtime, values are compatible
        const systemStep = step as any as SystemStep<
          Record<string, unknown>,
          Record<string, StepMeta>,
          unknown,
          Schema.Struct.Fields,
          string,
          true
        >

        const items = yield* systemStep
          .forEachItems(state, ctx)
          .pipe(
            Effect.mapError(
              (error) => new ForEachItemsError({ stepPath, error }),
            ),
          )

        return items
      }

      // Form with forEach
      // biome-ignore lint/suspicious/noExplicitAny: Type erasure at runtime, values are compatible
      const form = step as any as Form<
        Record<string, unknown>,
        Record<string, StepMeta | FormStepMeta>,
        Schema.Struct.Fields,
        string,
        unknown,
        true
      >

      const items = yield* form
        .forEachItems(state, ctx)
        .pipe(
          Effect.mapError(
            (error) => new ForEachItemsError({ stepPath, error }),
          ),
        )

      return items
    })

    return effect
  },
})
