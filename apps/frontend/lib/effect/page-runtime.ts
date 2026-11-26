import { Cause, Effect, Exit, type Layer } from "effect"
import { unstable_rethrow } from "next/navigation"

/** Each invocation owns its layers and finalizers, including on navigation. */
export const makePageRuntime = <R, E>(
  name: string,
  layer: Layer.Layer<R, E>,
) => ({
  build:
    <Args extends unknown[], A, E2>(
      handler: (...args: Args) => Effect.Effect<A, E2, R>,
    ) =>
    async (...args: Args): Promise<A> => {
      const exit = await Effect.runPromiseExit(
        Effect.suspend(() => handler(...args)).pipe(
          Effect.withSpan(name),
          Effect.provide(layer),
        ),
      )
      if (Exit.isSuccess(exit)) return exit.value
      // Framework control flow must retain its original exception, even when
      // another failure occurs during scope finalization.
      for (const reason of exit.cause.reasons) {
        if (Cause.isDieReason(reason)) unstable_rethrow(reason.defect)
        else if (Cause.isFailReason(reason)) unstable_rethrow(reason.error)
      }
      throw Cause.squash(exit.cause)
    },
})
