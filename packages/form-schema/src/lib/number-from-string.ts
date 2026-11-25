import {
  Effect,
  Number as EffectNumber,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect"

/** Preserve the authored numeric-string contract, including explicit non-finite values. */
export const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value) => {
      const parsed = EffectNumber.parse(value)
      return Option.isSome(parsed)
        ? Effect.succeed(parsed.value)
        : Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "Must be a numeric string" },
              value,
            ),
          )
    }),
    encode: SchemaGetter.transform(String),
  }),
)
