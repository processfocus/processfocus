import { Context, Schema as ES, Effect, Layer } from "effect"

/**
 * Form validation service for validating form data against Effect schemas.
 */
export class FormValidationService extends Context.Tag(
  "@pf/frontend/FormValidationService",
)<
  FormValidationService,
  {
    readonly validateFormData: <A, I>(
      schema: ES.Schema<A, I>,
      data: unknown,
    ) => Effect.Effect<A, Error>
  }
>() {}

/**
 * Form validation service layer implementation.
 */
export const FormValidationServiceLive = Layer.succeed(
  FormValidationService,
  FormValidationService.of({
    validateFormData: <A, I>(schema: ES.Schema<A, I>, data: unknown) =>
      Effect.try({
        try: () => {
          const result = ES.decodeUnknownEither(schema)(data)
          if (result._tag === "Right") {
            return result.right
          }
          throw new Error(result.left.message)
        },
        catch: (error) => new Error(`Form validation failed: ${String(error)}`),
      }),
  }),
)
