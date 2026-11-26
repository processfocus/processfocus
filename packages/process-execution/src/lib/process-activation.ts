import type { Effect } from "effect"
import type { ProcessProps } from "@pf/process"

type ActivationValidator = NonNullable<ProcessProps["validateActivation"]>

export const runProcessActivation = (
  validate: ActivationValidator,
  input: Parameters<ActivationValidator>[0],
): Effect.Effect<void, Effect.Error<ReturnType<ActivationValidator>>> =>
  // Runtime composition supplies organisation services, as for Form.onSubmit.
  validate(input) as Effect.Effect<
    void,
    Effect.Error<ReturnType<ActivationValidator>>
  >
