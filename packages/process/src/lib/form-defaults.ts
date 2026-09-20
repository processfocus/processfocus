import { Effect, Option, Schema, SchemaAST } from "effect"
import {
  CurrentProviderUser,
  FLATTEN_SYMBOL,
  FormDefault,
  STRUCTURAL_ONLY_SYMBOL,
  fieldAnnotation,
  fieldInputAst,
} from "@pf/form-schema"

const nestedAst = (ast: SchemaAST.AST): SchemaAST.TypeLiteral | undefined => {
  if (ast._tag === "TypeLiteral") return ast
  if (ast._tag === "Transformation" || ast._tag === "Refinement")
    return nestedAst(ast.from)
  if (ast._tag === "Union") {
    for (const type of ast.types) {
      const nested = nestedAst(type)
      if (nested) return nested
    }
  }
  return undefined
}

/** Authoritative annotated defaults only: never initialization placeholders. */
export const resolveFormFieldDefaults = (
  fields: Schema.Struct.Fields,
  currentProviderUser?: string,
): Effect.Effect<Record<string, unknown>, never> =>
  Effect.gen(function* () {
    const defaults: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(fields)) {
      const ast = fieldInputAst(field)
      if (fieldAnnotation(ast, STRUCTURAL_ONLY_SYMBOL)) continue
      const value = fieldAnnotation(ast, FormDefault)
      if (value !== undefined) {
        const resolved =
          typeof value === "function"
            ? yield* Effect.try(() => value()).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning(
                    `Failed to resolve default for field "${name}"`,
                    { error },
                  ),
                ),
                Effect.option,
              )
            : Option.some(value)
        if (Option.isSome(resolved)) {
          const actual =
            resolved.value === CurrentProviderUser
              ? currentProviderUser
              : resolved.value
          if (actual !== undefined) defaults[name] = actual
        }
        continue
      }
      const nested = nestedAst(ast)
      if (nested) {
        const children = yield* resolveFormFieldDefaults(
          Object.fromEntries(
            nested.propertySignatures.map((property) => [
              property.name,
              Schema.make(
                SchemaAST.annotations(property.type, property.annotations),
              ),
            ]),
          ),
          currentProviderUser,
        )
        if (fieldAnnotation(ast, FLATTEN_SYMBOL))
          Object.assign(defaults, children)
        else if (Object.keys(children).length) defaults[name] = children
      }
    }
    return defaults
  })

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null)

/** Submitted edits win while omitted nested values retain authored defaults. */
export const mergeFormDefaults = (
  defaults: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(input)) {
    const previous = defaults[key]
    Object.defineProperty(merged, key, {
      value:
        isPlainRecord(previous) && isPlainRecord(value)
          ? mergeFormDefaults(previous, value)
          : value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return merged
}
