import type { Effect, Schema } from "effect"
import type { ClientRepresentation } from "./types"
import { type WalkError, walkAST } from "./walker"

/**
 * Convert an Effect Schema.Struct to its client-side form representation
 *
 * This function walks the schema's AST and generates a typed structure
 * that mirrors the schema's type shape, with each field mapped to its
 * corresponding form component (TextField, NumberField, etc.).
 *
 * **IMPORTANT**: Only Schema.Struct is supported. The type system prevents
 * passing any other schema type at compile time.
 *
 * @param schema - The Effect Schema.Struct to convert
 * @returns An Effect that produces the client representation
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   username: Schema.String,
 *   age: Schema.NumberFromString,
 * })
 *
 * const representation = await Effect.runPromise(asClientRepresentation(schema))
 * // {
 * //   username: { field: "username", type: "text", label: "Username", ... },
 * //   age: { field: "age", _tag: "number", label: "Age", ... }
 * // }
 * ```
 */
export const asClientRepresentation = <
  const Fields extends Schema.Struct.Fields,
>(
  schema: Schema.Struct<Fields>,
): Effect.Effect<ClientRepresentation<Schema.Struct<Fields>>, WalkError> => {
  // Type assertion is necessary here because walkAST operates on the runtime AST
  // while ClientRepresentation is a compile-time type mapping. The runtime
  // structure returned by walkAST is guaranteed to match the compile-time type
  // by the implementation of walkAST.
  // SAFETY: The type parameter constrains input to Schema.Struct, ensuring
  // the AST root is always a TypeLiteral which walkAST handles correctly.
  return walkAST(schema.ast) as Effect.Effect<
    ClientRepresentation<Schema.Struct<Fields>>,
    WalkError
  >
}
