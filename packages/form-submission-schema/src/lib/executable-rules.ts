import { Result, Schema, SchemaAST } from "effect"
import {
  FormRequired,
  type ListFieldMarker,
  type ReadOnlyMarker,
  type StructuralOnlyMarker,
  fieldAnnotation,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isReadOnlyField,
} from "@pf/form-schema"
import {
  type FlattenFields,
  submissionSchemaSync,
} from "./form-submission-schema"

export interface ExecutableFieldState {
  readonly hidden?: boolean
  readonly disabled?: boolean
  readonly required?: boolean
  readonly label?: string
}

type DeclaredField<F> = F extends { readonly members: ReadonlyArray<infer M> }
  ? Exclude<DeclaredField<M>, typeof Schema.Undefined | typeof Schema.Null>
  : F extends { readonly schema: infer S }
    ? DeclaredField<S>
    : F

type Targets<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: DeclaredField<F[K]> extends
    | ReadOnlyMarker
    | StructuralOnlyMarker
    ? Omit<ExecutableFieldState, "required">
    : DeclaredField<F[K]> extends Schema.Struct<infer Children>
      ? Targets<Children> & {
          readonly $self?: Omit<ExecutableFieldState, "required">
        } & Omit<ExecutableFieldState, "required">
      : DeclaredField<F[K]> extends ListFieldMarker<infer Children>
        ? Targets<Children> & ExecutableFieldState
        : ExecutableFieldState
}
type Available<T> =
  T extends ReadonlyArray<unknown>
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: Available<T[K]> }
      : T

const rulesAnnotation = Symbol.for("pf/form/executable-rules")
type Rule = (
  values: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>

/** Rules live in the public schema module and execute over independently decoded input. */
export const withFormRules = <F extends Schema.Struct.Fields>(
  schema: Schema.Struct<F>,
  ...rules: ReadonlyArray<
    (
      values: Available<
        Schema.Struct.Type<
          FlattenFields<F> extends infer P extends Schema.Struct.Fields
            ? P
            : never
        >
      >,
    ) => Targets<F>
  >
): Schema.Struct<F> => schema.annotate({ [rulesAnnotation]: rules })

export interface ExecutableField {
  readonly kind: "input" | "container" | "display"
  readonly path: readonly string[]
  readonly target: readonly string[]
  readonly schema: Schema.Top
  readonly state: ExecutableFieldState
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (value: unknown, path: readonly string[]): unknown => {
  for (const key of path) {
    if (Array.isArray(value)) value = value[Number(key)]
    else if (record(value)) value = value[key]
    else return undefined
  }
  return value
}

const set = (
  value: Record<string, unknown> | unknown[],
  path: readonly string[],
  item: unknown,
): void => {
  const [key, ...rest] = path
  if (key === undefined) return
  if (Array.isArray(value)) {
    const index = Number(key)
    if (rest.length === 0) value[index] = item
    else {
      const child = value[index]
      if (record(child) || Array.isArray(child)) set(child, rest, item)
    }
    return
  }
  if (rest.length === 0) {
    if (item === undefined) delete value[key]
    else value[key] = item
    return
  }
  const child = value[key]
  if (record(child) || Array.isArray(child)) set(child, rest, item)
  else if (item !== undefined) {
    const nested: Record<string, unknown> = {}
    value[key] = nested
    set(nested, rest, item)
  }
}

const struct = (ast: SchemaAST.AST): SchemaAST.Objects | undefined => {
  if (ast._tag === "Objects") return ast
  if (ast._tag === "Union")
    for (const member of ast.types) {
      const found = struct(member)
      if (found) return found
    }
  return undefined
}

/** Invalid controlling values are unavailable, without rewriting raw editing state. */
const normalize = (schema: Schema.Top, input: unknown): unknown => {
  const result = Schema.decodeUnknownResult(
    Schema.make<Schema.Codec<unknown, unknown>>(schema.ast),
  )(input)
  if (Result.isSuccess(result)) return result.success
  const nested = struct(schema.ast)
  if (!nested || !record(input)) return undefined
  return Object.fromEntries(
    nested.propertySignatures.map((property) => [
      String(property.name),
      normalize(Schema.make(property.type), input[String(property.name)]),
    ]),
  )
}

export const executableFields = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  input: Record<string, unknown>,
  inaccessible: readonly string[] = [],
  originals?: Record<string, unknown>,
): readonly ExecutableField[] => {
  const declared: unknown = Reflect.get(
    schema.ast.annotations ?? {},
    rulesAnnotation,
  )
  const rules = Array.isArray(declared)
    ? declared.filter((rule): rule is Rule => typeof rule === "function")
    : []
  const applicable = structuredClone(input)
  for (const name of inaccessible) set(applicable, name.split("."), undefined)
  const normalized = normalize(submissionSchemaSync(schema), applicable)
  // Decoding defaults must not restore permission-inapplicable rule inputs.
  if (record(normalized))
    for (const name of inaccessible) set(normalized, name.split("."), undefined)
  const effects = rules.map((rule) =>
    rule(record(normalized) ? normalized : {}),
  )
  const fields: ExecutableField[] = []
  const walk = (
    ast: Schema.Top,
    path: readonly string[],
    target: readonly string[],
    inherited: ExecutableFieldState,
    excluded = false,
    absentContainer = false,
  ): void => {
    const encoded = SchemaAST.toEncoded(ast.ast)
    const intrinsicRequired =
      rules.length > 0 &&
      !encoded.context?.isOptional &&
      encoded._tag !== "Undefined" &&
      encoded._tag !== "Null" &&
      !(
        encoded._tag === "Union" &&
        encoded.types.some(
          (member) => member._tag === "Undefined" || member._tag === "Null",
        )
      )
    let state: ExecutableFieldState = {}
    for (const effect of effects) {
      const entry = at(effect, target)
      if (!record(entry)) continue
      const own = record(entry["$self"]) ? entry["$self"] : entry
      state = {
        ...state,
        ...(typeof own["hidden"] === "boolean"
          ? { hidden: own["hidden"] }
          : {}),
        ...(typeof own["disabled"] === "boolean"
          ? { disabled: own["disabled"] }
          : {}),
        ...(typeof own["required"] === "boolean"
          ? { required: own["required"] }
          : {}),
        ...(typeof own["label"] === "string" ? { label: own["label"] } : {}),
      }
    }
    state = {
      ...state,
      ...(inherited.hidden ||
      inaccessible.some(
        (name) =>
          path.join(".") === name || path.join(".").startsWith(`${name}.`),
      )
        ? { hidden: true }
        : {}),
      ...(inherited.disabled ? { disabled: true } : {}),
      ...(fieldAnnotation(ast.ast, FormRequired) === true ||
      (intrinsicRequired && !absentContainer)
        ? { required: true }
        : {}),
    }
    const nested = struct(ast.ast)
    // Disabled containers are traversed against the values that will survive
    // submission, while rule conditions still evaluate the submitted input.
    const value = at(state.disabled && originals ? originals : input, path)
    const display =
      excluded || hasStructuralOnlyAnnotation(ast) || isReadOnlyField(ast)
    fields.push({
      path,
      target,
      schema: ast,
      state,
      kind: display ? "display" : nested ? "container" : "input",
    })
    if (nested) {
      for (const property of nested.propertySignatures) {
        const child = Schema.make(property.type)
        const name = String(property.name)
        walk(
          Schema.make<Schema.Top>(child.ast),
          hasFlattenAnnotation(child) ? path : [...path, name],
          [...target, name],
          state,
          display,
          absentContainer ||
            (!hasFlattenAnnotation(ast) && !intrinsicRequired && value == null),
        )
      }
    }
    const array =
      encoded._tag === "Arrays"
        ? encoded
        : encoded._tag === "Union"
          ? encoded.types.find((member) => member._tag === "Arrays")
          : undefined
    const items = value
    if (array?._tag === "Arrays" && Array.isArray(items)) {
      for (const [index] of items.entries()) {
        const item = array.elements[index] ?? array.rest[0]
        const children = item && struct(item)
        if (!children) continue
        for (const property of children.propertySignatures) {
          const name = String(property.name)
          const child = Schema.make<Schema.Top>(property.type)
          const itemPath = [...path, String(index)]
          walk(
            child,
            hasFlattenAnnotation(child) ? itemPath : [...itemPath, name],
            [...target, name],
            state,
            display,
            absentContainer,
          )
        }
      }
    }
  }
  for (const [name, child] of Object.entries(schema.fields)) {
    walk(
      Schema.make<Schema.Top>(child.ast),
      hasFlattenAnnotation(child) ? [] : [name],
      [name],
      {},
    )
  }
  return fields
}

/** Stored process values are decoded; authored defaults are already encoded. */
export const executableOriginalValues = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  defaults: Record<string, unknown>,
  state: Record<string, unknown> = {},
): Record<string, unknown> => {
  const values = structuredClone(defaults)
  for (const field of executableFields(schema, defaults)) {
    if (field.kind !== "input") continue
    const original = at(state, field.path)
    if (original === undefined) continue
    const encoded = Schema.encodeUnknownResult(
      Schema.make<Schema.Codec<unknown, unknown>>(field.schema.ast),
    )(original)
    // Persisted codecs such as DateTime are already serialized on the state boundary.
    set(
      values,
      field.path,
      Result.isSuccess(encoded) ? encoded.success : original,
    )
  }
  return values
}

/** Returns encoded submission values; hidden drafts are left untouched. */
export const prepareExecutableSubmission = (
  schema: Schema.Struct<Schema.Struct.Fields>,
  input: Record<string, unknown>,
  originals: Record<string, unknown>,
  inaccessible: readonly string[] = [],
): {
  readonly values: Record<string, unknown>
  readonly errors: readonly { field: string; message: string }[]
} => {
  const values = structuredClone(input)
  const errors: Array<{ field: string; message: string }> = []
  const fields = executableFields(schema, input, inaccessible, originals)
  for (const field of fields) {
    const { path, state } = field
    if (field.kind === "container") {
      if (!hasFlattenAnnotation(field.schema)) {
        if (state.hidden) set(values, path, undefined)
        else if (state.disabled) set(values, path, at(originals, path))
      }
      continue
    }
    if (field.kind === "display") {
      // Display paths may overlap valid flattened inputs; projection excludes displays.
      if (
        !fields.some(
          (other) =>
            other.kind === "input" &&
            path.every((part, index) => other.path[index] === part),
        )
      )
        set(values, path, undefined)
      continue
    }
    if (state.hidden) {
      if (
        state.required &&
        !inaccessible.some(
          (name) =>
            path.join(".") === name || path.join(".").startsWith(`${name}.`),
        )
      )
        errors.push({
          field: path.join("."),
          message: "Field cannot be required while hidden",
        })
      set(values, path, undefined)
      continue
    }
    if (state.disabled) {
      set(values, path, at(originals, path))
    }
    const value = at(values, path)
    if (
      state.required &&
      (value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0))
    ) {
      errors.push({ field: path.join("."), message: "Required" })
    }
  }
  return { values, errors }
}
