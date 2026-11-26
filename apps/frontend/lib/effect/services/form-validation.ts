import { Context, Data, Schema as ES, Effect, Layer } from "effect"

export class FormValidationError extends Data.TaggedError(
  "FormValidationError",
)<{
  readonly message: string
}> {}

/**
 * Form validation service for validating form data against Effect schemas.
 */
export class FormValidationService extends Context.Service<
  FormValidationService,
  {
    readonly validateFormData: <A, I>(
      schema: ES.Codec<A, I>,
      data: unknown,
    ) => Effect.Effect<A, FormValidationError>
  }
>()("@pf/frontend/FormValidationService") {}

/**
 * Form validation service layer implementation.
 */
export const FormValidationServiceLive = Layer.succeed(
  FormValidationService,
  FormValidationService.of({
    validateFormData: <A, I>(schema: ES.Codec<A, I>, data: unknown) =>
      ES.decodeUnknownEffect(schema)(data).pipe(
        Effect.mapError(
          (error) =>
            new FormValidationError({
              message: `Form validation failed: ${error.message}`,
            }),
        ),
      ),
  }),
)
