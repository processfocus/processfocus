import { Data, Effect, Either, Schema, SchemaAST } from "effect"
import {
  type FlattenMarker,
  type ListFieldMarker,
  type ReadOnlyMarker,
  type StructuralOnlyMarker,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isReadOnlyField,
  mapFormPropertySignature,
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

// Type utility to convert union to intersection
type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

type IsExcluded<Field> = Field extends StructuralOnlyMarker | ReadOnlyMarker
  ? true
  : Field extends { readonly from: infer From }
    ? IsExcluded<From>
    : Field extends { readonly members: ReadonlyArray<infer Member> }
      ? true extends IsExcluded<Member>
        ? true
        : false
      : false

type ProjectedStruct<Fields extends Schema.Struct.Fields> = Schema.Struct<
  FlattenFields<Fields> extends infer F extends Schema.Struct.Fields ? F : never
>

// Preserve wrapper contracts while projecting their contained schemas.
type ProjectSchema<S extends Schema.Schema.All> =
  S extends Schema.Struct<infer Fields>
    ? ProjectedStruct<Fields>
    : S extends ListFieldMarker<infer Items>
      ? Schema.Array$<ProjectedStruct<Items>>
      : S extends Schema.Union<infer Members>
        ? Schema.Union<{
            [K in keyof Members]: ProjectSchema<Members[K]>
          }>
        : S extends Schema.transformOrFail<infer From, infer To, infer R>
          ? Schema.Schema<
              Schema.Schema.Type<ProjectSchema<To>>,
              Schema.Schema.Encoded<ProjectSchema<From>>,
              | R
              | Schema.Schema.Context<ProjectSchema<From>>
              | Schema.Schema.Context<ProjectSchema<To>>
            >
          : S extends Schema.refine<infer A, infer From>
            ? Schema.Schema<
                Schema.Schema.Type<ProjectSchema<From>> &
                  Omit<A, keyof Schema.Schema.Type<From>>,
                Schema.Schema.Encoded<ProjectSchema<From>>,
                Schema.Schema.Context<ProjectSchema<From>>
              >
            : S

type ProjectField<Field extends Schema.Struct.Fields[string]> =
  Field extends Schema.PropertySignature<
    infer TT,
    infer A,
    infer Key,
    infer ET,
    infer I,
    infer Default,
    infer _R
  > & { readonly from: infer From extends Schema.Schema.All }
    ? Schema.PropertySignature<
        TT,
        | Schema.Schema.Type<ProjectSchema<From>>
        | Exclude<A, Schema.Schema.Type<From>>,
        Key,
        ET,
        | Schema.Schema.Encoded<ProjectSchema<From>>
        | Exclude<I, Schema.Schema.Encoded<From>>,
        Default,
        Schema.Schema.Context<ProjectSchema<From>>
      >
    : Field extends Schema.Schema.All
      ? ProjectSchema<Field>
      : Field

// Wrapper fields flatten; ordinary containers keep their keys and optionality.
export type FlattenFields<Fields extends Schema.Struct.Fields> =
  UnionToIntersection<
    {
      [K in keyof Fields]: IsExcluded<Fields[K]> extends true
        ? never
        : Fields[K] extends Schema.Struct<infer F> & FlattenMarker
          ? FlattenFields<F>
          : { [P in K]: ProjectField<Fields[K]> }
    }[keyof Fields]
  >

export const isStructSchema = (
  field: Schema.Schema.Any,
): field is Schema.Struct<Schema.Struct.Fields> =>
  field.ast._tag === "TypeLiteral" && "fields" in field

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
  field: Schema.Schema.Any,
  fieldName: string,
): Effect.Effect<boolean, InvalidFlattenAnnotationError> =>
  Effect.gen(function* () {
    const hasFlatten = hasFlattenAnnotation(field)
    const isStructAst = field.ast._tag === "TypeLiteral"

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
      const fieldAsAny = field as Schema.Schema.Any

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
          flatFields[nestedKey] = nestedValue as Schema.Schema.Any
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
  Effect.gen(function* () {
    if (!Schema.isPropertySignature(field))
      return Schema.make(yield* projectNested(field.ast))
    const signature = field.ast
    const input = yield* projectNested(
      signature._tag === "PropertySignatureDeclaration"
        ? signature.type
        : signature.from.type,
    )
    const output =
      signature._tag === "PropertySignatureDeclaration"
        ? input
        : yield* projectNested(signature.to.type)
    return mapFormPropertySignature(field, (_ast, side) =>
      side === "input" ? input : output,
    )
  })

const projectNested = (
  ast: SchemaAST.AST,
): Effect.Effect<SchemaAST.AST, SubmissionSchemaError> =>
  Effect.gen(function* () {
    if (ast._tag === "TypeLiteral") {
      const properties: SchemaAST.PropertySignature[] = []
      const names = new Set<PropertyKey>()
      for (const property of ast.propertySignatures) {
        const field = Schema.make(
          SchemaAST.annotations(property.type, property.annotations),
        )
        if (hasStructuralOnlyAnnotation(field) || isReadOnlyField(field))
          continue
        const flatten = yield* isFlattenableStruct(field, String(property.name))
        const projected = yield* projectNested(property.type)
        const children =
          flatten && projected._tag === "TypeLiteral"
            ? projected.propertySignatures
            : [
                new SchemaAST.PropertySignature(
                  property.name,
                  projected,
                  property.isOptional,
                  property.isReadonly,
                  property.annotations,
                ),
              ]
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
      return new SchemaAST.TypeLiteral(
        properties,
        ast.indexSignatures,
        ast.annotations,
      )
    }
    if (ast._tag === "Union")
      return SchemaAST.Union.make(
        yield* Effect.forEach(ast.types, projectNested),
        ast.annotations,
      )
    if (ast._tag === "Refinement")
      return new SchemaAST.Refinement(
        yield* projectNested(ast.from),
        ast.filter,
        ast.annotations,
      )
    if (ast._tag === "Transformation") {
      const from = yield* projectNested(ast.from)
      const to = yield* projectNested(ast.to)
      // Removed fields must not be reintroduced by an intrinsic property default.
      const transformation =
        ast.transformation._tag === "TypeLiteralTransformation" &&
        from._tag === "TypeLiteral" &&
        to._tag === "TypeLiteral"
          ? new SchemaAST.TypeLiteralTransformation(
              ast.transformation.propertySignatureTransformations.filter(
                (property) =>
                  from.propertySignatures.some(
                    (p) => p.name === property.from,
                  ) &&
                  to.propertySignatures.some((p) => p.name === property.to),
              ),
            )
          : ast.transformation
      return new SchemaAST.Transformation(
        from,
        to,
        transformation,
        ast.annotations,
      )
    }
    if (ast._tag === "TupleType") {
      const elements = yield* Effect.forEach(ast.elements, (element) =>
        projectNested(element.type).pipe(
          Effect.map(
            (type) =>
              new SchemaAST.OptionalType(
                type,
                element.isOptional,
                element.annotations,
              ),
          ),
        ),
      )
      const rest = yield* Effect.forEach(ast.rest, (element) =>
        projectNested(element.type).pipe(
          Effect.map((type) => new SchemaAST.Type(type, element.annotations)),
        ),
      )
      return new SchemaAST.TupleType(
        elements,
        rest,
        ast.isReadonly,
        ast.annotations,
      )
    }
    return ast
  })

/**
 * Synchronous boundary for model construction and other non-Effect call sites.
 * Rethrows the original TaggedError on failure (not a FiberFailure wrapper).
 */
export const submissionSchemaSync = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
): FlattenedSubmissionStruct<Fields> => {
  const result = Effect.runSync(Effect.either(submissionSchema(schema)))
  if (Either.isLeft(result)) {
    throw result.left
  }
  return result.right
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
    const ast = source
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
                  matches: Schema.is(
                    Schema.encodedSchema(Schema.make(projected)),
                  ),
                }
              }),
            ),
          )
        } else if (node._tag === "TypeLiteral") {
          yield* Effect.forEach(node.propertySignatures, (property) => {
            const field = Schema.make(
              SchemaAST.annotations(property.type, property.annotations),
            )
            return hasStructuralOnlyAnnotation(field) || isReadOnlyField(field)
              ? Effect.void
              : visit(property.type)
          })
        } else if (node._tag === "TupleType") {
          yield* Effect.forEach([...node.elements, ...node.rest], (element) =>
            visit(element.type),
          )
        } else if (
          node._tag === "Refinement" ||
          node._tag === "Transformation"
        ) {
          yield* visit(node.from)
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
  if (ast._tag === "Transformation" || ast._tag === "Refinement")
    return expandNestedInput(ast.from, input, members)
  if (ast._tag === "Union") {
    const member = members
      .get(ast)
      ?.find((candidate) => candidate.matches(input))
    return member ? expandNestedInput(member.ast, input, members) : input
  }
  if (ast._tag === "TypeLiteral" && isInputRecord(input))
    return expandStructInput(ast, input, members)
  if (ast._tag === "TupleType" && Array.isArray(input))
    return input.map((value, index) => {
      const element = ast.elements[index] ?? ast.rest[0]
      return element ? expandNestedInput(element.type, value, members) : value
    })
  return input
}

const expandStructInput = (
  ast: SchemaAST.AST,
  input: Record<string, unknown>,
  members: UnionMembers,
): Record<string, unknown> => {
  if (ast._tag === "Transformation" || ast._tag === "Refinement")
    return expandStructInput(ast.from, input, members)
  if (ast._tag !== "TypeLiteral") return input
  const expanded: Record<string, unknown> = {}
  for (const property of ast.propertySignatures) {
    if (typeof property.name !== "string") continue
    const key = property.name
    const field = Schema.make(
      SchemaAST.annotations(property.type, property.annotations),
    )
    if (hasStructuralOnlyAnnotation(field) || isReadOnlyField(field)) continue
    if (hasFlattenAnnotation(field)) {
      expanded[key] = expandNestedInput(property.type, input, members)
      continue
    }
    if (Object.hasOwn(input, key)) {
      expanded[key] = expandNestedInput(property.type, input[key], members)
      continue
    }
    if (!property.isOptional && property.type._tag === "TypeLiteral")
      expanded[key] = expandStructInput(property.type, {}, members)
  }
  return expanded
}
