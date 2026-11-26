import { Data, Effect, Result, Schema, SchemaAST } from "effect"
import {
  type FlattenMarker,
  type ListFieldMarker,
  type ReadOnlyMarker,
  type StructuralOnlyMarker,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isReadOnlyField,
} from "@pf/form-schema"

// Error for field name collisions during flattening
export class FieldNameCollisionError extends Data.TaggedError(
  "FieldNameCollisionError",
)<{
  readonly fieldName: string
  readonly wrapperField: string
}> {
  override get message() {
    return `Field name collision: "${this.wrapperField}" is already present as "${this.fieldName}" in its parent struct`
  }
}

// Error for invalid flatten annotation usage (on non-struct fields)
export class InvalidFlattenAnnotationError extends Data.TaggedError(
  "InvalidFlattenAnnotationError",
)<{
  readonly fieldName: string
  readonly astTag: string
}> {
  override get message() {
    return `Invalid schema: field "${this.fieldName}" has flatten annotation but is not a struct (AST tag: ${this.astTag}). Only use Wrapper() with Schema.Struct().`
  }
}

type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

type IsExcluded<Field> = Field extends StructuralOnlyMarker | ReadOnlyMarker
  ? true
  : Field extends { readonly schema: infer Inner }
    ? IsExcluded<Inner>
    : Field extends { readonly from: infer From }
      ? IsExcluded<From>
      : Field extends { readonly members: ReadonlyArray<infer Member> }
        ? true extends IsExcluded<Member>
          ? true
          : false
        : false

type ProjectedStruct<
  Fields extends Schema.Struct.Fields,
  KeepReadOnly extends boolean,
> = Schema.Struct<
  (
    KeepReadOnly extends true
      ? FlattenFieldsKeepingReadOnly<Fields>
      : FlattenFields<Fields>
  ) extends infer F extends Schema.Struct.Fields
    ? F
    : never
>

// Preserve wrapper contracts while projecting their contained schemas.
// Detail arrays recurse like ListField; ordinary submission arrays retain their
// existing projection.
type ProjectSchema<
  S extends Schema.Constraint,
  KeepReadOnly extends boolean = false,
> =
  S extends Schema.Struct<infer Fields>
    ? ProjectedStruct<Fields, KeepReadOnly>
    : S extends ListFieldMarker<infer Items>
      ? Schema.$Array<ProjectedStruct<Items, KeepReadOnly>>
      : S extends Schema.Union<infer Members>
        ? Schema.Union<{
            [K in keyof Members]: ProjectSchema<Members[K], KeepReadOnly>
          }>
        : S extends Schema.optionalKey<infer Inner>
          ? Schema.optionalKey<ProjectSchema<Inner, KeepReadOnly>>
          : S extends Schema.optional<infer Inner>
            ? Schema.optional<ProjectSchema<Inner, KeepReadOnly>>
            : S extends Schema.decodeTo<
                  infer To,
                  infer From,
                  infer RD,
                  infer RE
                >
              ? Schema.decodeTo<
                  ProjectSchema<To, KeepReadOnly>,
                  ProjectSchema<From, KeepReadOnly>,
                  RD,
                  RE
                >
              : S extends Schema.toType<infer Inner>
                ? Schema.toType<ProjectSchema<Inner, KeepReadOnly>>
                : S extends Schema.toEncoded<infer Inner>
                  ? Schema.toEncoded<ProjectSchema<Inner, KeepReadOnly>>
                  : KeepReadOnly extends true
                    ? S extends Schema.$Array<infer Item>
                      ? Schema.$Array<ProjectSchema<Item, KeepReadOnly>>
                      : S
                    : S

type ProjectField<Field extends Schema.Struct.Fields[string]> =
  ProjectSchema<Field>

type WrapperFields<Field> = Field extends Schema.Struct<infer Fields> &
  FlattenMarker
  ? FlattenFields<Fields>
  : Field extends Schema.toEncoded<infer Inner>
    ? WrapperFields<Inner> extends infer Fields extends Schema.Struct.Fields
      ? { [K in keyof Fields]: Schema.toEncoded<Fields[K]> }
      : never
    : never

// Wrapper fields flatten; ordinary containers keep their keys and optionality.
export type FlattenFields<Fields extends Schema.Struct.Fields> =
  UnionToIntersection<
    {
      [K in keyof Fields]: IsExcluded<Fields[K]> extends true
        ? never
        : [WrapperFields<Fields[K]>] extends [never]
          ? { [P in K]: ProjectField<Fields[K]> }
          : WrapperFields<Fields[K]>
    }[keyof Fields]
  >

type IsStructuralOnly<Field> = Field extends StructuralOnlyMarker
  ? true
  : Field extends { readonly schema: infer Inner }
    ? IsStructuralOnly<Inner>
    : Field extends { readonly from: infer From }
      ? IsStructuralOnly<From>
      : Field extends { readonly members: ReadonlyArray<infer Member> }
        ? true extends IsStructuralOnly<Member>
          ? true
          : false
        : false

type WrapperFieldsKeepingReadOnly<Field> = Field extends Schema.Struct<
  infer Fields
> &
  FlattenMarker
  ? FlattenFieldsKeepingReadOnly<Fields>
  : Field extends Schema.toEncoded<infer Inner>
    ? WrapperFieldsKeepingReadOnly<Inner> extends infer Fields extends
        Schema.Struct.Fields
      ? { [K in keyof Fields]: Schema.toEncoded<Fields[K]> }
      : never
    : never

/**
 * Flatten wrapper fields like `FlattenFields`, but keep read-only fields:
 * detail/output data is display-only content that queries still return.
 * Structural-only elements are omitted, matching GraphQL output walking.
 */
export type FlattenFieldsKeepingReadOnly<Fields extends Schema.Struct.Fields> =
  UnionToIntersection<
    {
      [K in keyof Fields]: IsStructuralOnly<Fields[K]> extends true
        ? never
        : [WrapperFieldsKeepingReadOnly<Fields[K]>] extends [never]
          ? { [P in K]: ProjectSchema<Fields[K], true> }
          : WrapperFieldsKeepingReadOnly<Fields[K]>
    }[keyof Fields]
  >

export const isStructSchema = (
  field: Schema.Constraint,
): field is Schema.Struct<Schema.Struct.Fields> =>
  field.ast._tag === "Objects" && "fields" in field

type FlattenedSubmissionStruct<Fields extends Schema.Struct.Fields> =
  Schema.Struct<
    FlattenFields<Fields> extends infer F extends Schema.Struct.Fields
      ? F
      : never
  >

export type SubmissionSchemaError =
  | FieldNameCollisionError
  | InvalidFlattenAnnotationError

// Checks whether a field is a flattenable Wrapper struct (errors on invalid annotation).
const isFlattenableStruct = (
  field: Schema.Constraint,
  fieldName: string,
): Effect.Effect<boolean, InvalidFlattenAnnotationError> =>
  Effect.gen(function* () {
    const hasFlatten = hasFlattenAnnotation(field)
    const isStructAst = field.ast._tag === "Objects"

    // Defensive: if has flatten annotation but isn't a struct, that's a programming error
    if (hasFlatten && !isStructAst) {
      return yield* new InvalidFlattenAnnotationError({
        fieldName,
        astTag: field.ast._tag,
      })
    }

    return hasFlatten && isStructAst
  })

// Creates a submission schema by flattening Wrapper fields while preserving regular nested structs
export const submissionSchema = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
): Effect.Effect<FlattenedSubmissionStruct<Fields>, SubmissionSchemaError> =>
  Effect.gen(function* () {
    const flatFields: Record<string, Schema.Struct.Fields[string]> = {}

    for (const [key, field] of Object.entries(schema.fields)) {
      const fieldAsAny = field as Schema.Top

      if (hasStructuralOnlyAnnotation(fieldAsAny)) {
        // Skip structural-only fields (UI-only, not in submission)
        continue
      }

      if (isReadOnlyField(fieldAsAny)) {
        // Skip read-only fields (display-only, not submittable)
        continue
      }

      if (yield* isFlattenableStruct(fieldAsAny, String(key))) {
        // This is a Wrapper - recursively flatten it first to handle nested Wrappers
        const recursivelyFlattened = yield* submissionSchema(
          fieldAsAny as Schema.Struct<Schema.Struct.Fields>,
        )

        // Spread the recursively flattened fields with collision detection
        for (const [nestedKey, nestedValue] of Object.entries(
          recursivelyFlattened.fields,
        )) {
          if (nestedKey in flatFields) {
            return yield* new FieldNameCollisionError({
              fieldName: nestedKey,
              wrapperField: `${key}...${nestedKey}`,
            })
          }
          flatFields[nestedKey] = nestedValue as Schema.Top
        }
      } else {
        if (key in flatFields)
          return yield* new FieldNameCollisionError({
            fieldName: key,
            wrapperField: key,
          })
        // Project nested containers without changing their nesting or array cardinality.
        flatFields[key] = yield* projectField(field)
      }
    }

    yield* prepareExpansion(schema.ast)
    return Schema.Struct(
      flatFields,
    ) as unknown as FlattenedSubmissionStruct<Fields>
  })

/** Rebuild signatures without losing intrinsic defaults, key mappings or codecs. */
const projectField = (
  field: Schema.Struct.Fields[string],
): Effect.Effect<Schema.Struct.Fields[string], SubmissionSchemaError> =>
  Effect.map(projectNested(field.ast), (ast) => Schema.make(ast))

const projectNested = (
  ast: SchemaAST.AST,
): Effect.Effect<SchemaAST.AST, SubmissionSchemaError> =>
  Effect.gen(function* () {
    const encoding = ast.encoding
      ? yield* Effect.forEach(ast.encoding, (link) =>
          Effect.map(
            projectNested(link.to),
            (to) => new SchemaAST.Link(to, link.transformation),
          ),
        )
      : undefined
    if (ast._tag === "Objects") {
      const properties: SchemaAST.PropertySignature[] = []
      const names = new Set<PropertyKey>()
      for (const property of ast.propertySignatures) {
        const field = Schema.make(property.type)
        if (hasStructuralOnlyAnnotation(field) || isReadOnlyField(field))
          continue
        const flatten = yield* isFlattenableStruct(field, String(property.name))
        const projected = yield* projectNested(property.type)
        const children =
          flatten && projected._tag === "Objects"
            ? projected.propertySignatures
            : [new SchemaAST.PropertySignature(property.name, projected)]
        for (const child of children) {
          if (names.has(child.name))
            return yield* new FieldNameCollisionError({
              fieldName: String(child.name),
              wrapperField: `${String(property.name)}...${String(child.name)}`,
            })
          names.add(child.name)
          properties.push(child)
        }
      }
      return new SchemaAST.Objects(
        properties,
        ast.indexSignatures,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      )
    }
    if (ast._tag === "Union")
      return new SchemaAST.Union(
        yield* Effect.forEach(ast.types, projectNested),
        ast.options,
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      )
    if (ast._tag === "Arrays")
      return new SchemaAST.Arrays(
        ast.isMutable,
        yield* Effect.forEach(ast.elements, projectNested),
        yield* Effect.forEach(ast.rest, projectNested),
        ast.annotations,
        ast.checks,
        encoding,
        ast.context,
        ast.encodingChecks,
      )
    return encoding
      ? Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, {
          encoding,
        })
      : ast
  })

/**
 * Synchronous boundary for model construction and other non-Effect call sites.
 * Rethrows the original TaggedError on failure (not a FiberFailure wrapper).
 */
export const submissionSchemaSync = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
): FlattenedSubmissionStruct<Fields> => {
  const result = Effect.runSync(Effect.result(submissionSchema(schema)))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

export const expandSubmissionInput = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  input: Record<string, unknown>,
): Record<string, unknown> => {
  // Accepted schemas are prepared during construction. Direct callers prepare once.
  const prepared =
    expansionCache.get(schema.ast) ??
    Effect.runSync(prepareExpansion(schema.ast))
  return expandStructInput(prepared.ast, input, prepared.members)
}

type UnionMember = {
  readonly ast: SchemaAST.AST
  readonly matches: (input: unknown) => boolean
}
type UnionMembers = ReadonlyMap<SchemaAST.AST, ReadonlyArray<UnionMember>>

const expansionCache = new WeakMap<
  SchemaAST.AST,
  { readonly ast: SchemaAST.AST; readonly members: UnionMembers }
>()

// Compile encoded union selectors at schema construction, never per submission/row.
const prepareExpansion = (source: SchemaAST.AST) =>
  Effect.gen(function* () {
    const cached = expansionCache.get(source)
    if (cached) return cached
    // Keep authored annotations: encodedAST drops them when rebuilding codec containers.
    // Traversal follows .from at each codec, so expansion still operates on wire values.
    const ast = SchemaAST.toEncoded(source)
    const members = new Map<SchemaAST.AST, ReadonlyArray<UnionMember>>()
    const visit = (
      node: SchemaAST.AST,
    ): Effect.Effect<void, SubmissionSchemaError> =>
      Effect.gen(function* () {
        if (node._tag === "Union") {
          members.set(
            node,
            yield* Effect.forEach(node.types, (member) =>
              Effect.gen(function* () {
                const projected = yield* projectNested(member)
                yield* visit(member)
                return {
                  ast: member,
                  matches: Schema.is(Schema.toEncoded(Schema.make(projected))),
                }
              }),
            ),
          )
        } else if (node._tag === "Objects") {
          yield* Effect.forEach(node.propertySignatures, (property) => {
            const field = Schema.make(property.type)
            return hasStructuralOnlyAnnotation(field) || isReadOnlyField(field)
              ? Effect.void
              : visit(property.type)
          })
        } else if (node._tag === "Arrays") {
          yield* Effect.forEach([...node.elements, ...node.rest], (element) =>
            visit(element),
          )
        }
      })
    yield* visit(ast)
    const prepared = { ast, members }
    expansionCache.set(source, prepared)
    return prepared
  })

const isInputRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

// Expansion rearranges encoded values; it must not run business codecs or defaults.
const expandNestedInput = (
  ast: SchemaAST.AST,
  input: unknown,
  members: UnionMembers,
): unknown => {
  if (ast._tag === "Union") {
    const member = members
      .get(ast)
      ?.find((candidate) => candidate.matches(input))
    return member ? expandNestedInput(member.ast, input, members) : input
  }
  if (ast._tag === "Objects" && isInputRecord(input))
    return expandStructInput(ast, input, members)
  if (ast._tag === "Arrays" && Array.isArray(input))
    return input.map((value, index) => {
      const element = ast.elements[index] ?? ast.rest[0]
      return element ? expandNestedInput(element, value, members) : value
    })
  return input
}

const expandStructInput = (
  ast: SchemaAST.AST,
  input: Record<string, unknown>,
  members: UnionMembers,
): Record<string, unknown> => {
  if (ast._tag !== "Objects") return input
  const expanded: Record<string, unknown> = {}
  for (const property of ast.propertySignatures) {
    if (typeof property.name !== "string") continue
    const key = property.name
    const field = Schema.make(property.type)
    if (hasStructuralOnlyAnnotation(field) || isReadOnlyField(field)) continue
    if (hasFlattenAnnotation(field)) {
      expanded[key] = expandNestedInput(property.type, input, members)
      continue
    }
    if (Object.hasOwn(input, key)) {
      expanded[key] = expandNestedInput(property.type, input[key], members)
      continue
    }
    if (!property.type.context?.isOptional && property.type._tag === "Objects")
      expanded[key] = expandStructInput(property.type, {}, members)
  }
  return expanded
}
