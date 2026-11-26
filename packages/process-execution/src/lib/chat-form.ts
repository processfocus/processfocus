import { SchemaAST } from "effect"
import {
  FormCalendarSlotInput,
  FormCheckboxGroupInput,
  FormComponentPluginType,
  FormDescription,
  FormFileInput,
  FormLabel,
  FormLookupInput,
  FormProviderUserInput,
  FormRadioInput,
  FormReadOnly,
  FormRequired,
  FormSuggestionInput,
  fieldAnnotation,
  hasFlattenAnnotation,
} from "@pf/form-schema"
import { executableFields } from "@pf/form-submission-schema"

const valueAt = (value: unknown, path: readonly string[]): unknown => {
  for (const key of path) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, key)
    )
      return undefined
    value = Reflect.get(value, key)
  }
  return value
}

const valueTypes = (ast: SchemaAST.AST): SchemaAST.AST[] =>
  ast._tag === "Union" ? ast.types.flatMap(valueTypes) : [ast]

const scalar = (ast: SchemaAST.AST): boolean =>
  ast._tag === "String" ||
  ast._tag === "Number" ||
  ast._tag === "Boolean" ||
  (ast._tag === "Literal" && typeof ast.literal !== "bigint")

const dashboardControls = [
  FormCalendarSlotInput,
  FormComponentPluginType,
  FormFileInput,
  FormLookupInput,
  FormProviderUserInput,
  FormSuggestionInput,
]

const needsDashboardControl = (field: Parameters<typeof fieldAnnotation>[0]) =>
  dashboardControls.some((key) => fieldAnnotation(field, key) !== undefined)

const contains = (parent: readonly string[], child: readonly string[]) =>
  parent.length < child.length &&
  parent.every((key, index) => child[index] === key)

export const chatFields = ({
  schema,
  values,
  defaults,
  originals,
  input,
  inaccessible,
  presentation,
}: {
  readonly schema: Parameters<typeof executableFields>[0]
  readonly values: Record<string, unknown>
  readonly defaults: Record<string, unknown>
  readonly originals: Record<string, unknown>
  readonly input: Record<string, unknown>
  readonly inaccessible: readonly string[]
  readonly presentation: Readonly<
    Record<
      string,
      {
        readonly label?: string | undefined
        readonly description?: string | undefined
      }
    >
  >
}) => {
  const fields = executableFields(schema, values, inaccessible, originals)
  const projected = fields.map((field) => {
    const encoded = SchemaAST.toEncoded(field.schema.ast)
    const types = valueTypes(encoded)
    return {
      ...field,
      encoded,
      types,
      acceptsNull:
        field.state.required !== true &&
        types.some((variant) => variant._tag === "Null"),
    }
  })
  return projected.flatMap(
    ({ kind, schema, path, target, state, encoded, types, acceptsNull }) => {
      const annotation = (key: symbol) => fieldAnnotation(schema.ast, key)
      const readOnly = kind === "display" && annotation(FormReadOnly) === true
      const dashboardControl = needsDashboardControl(schema.ast)
      const parents = projected.filter((parent) => contains(parent.path, path))
      const nullableParents = parents.filter(
        (parent) => parent.kind === "container" && parent.acceptsNull,
      )
      const parentValue = (parent: (typeof projected)[number]) =>
        valueAt(parent.state.disabled ? originals : values, parent.path)
      if (
        !(
          kind === "input" ||
          readOnly ||
          (kind === "container" && (dashboardControl || acceptsNull))
        ) ||
        state.hidden ||
        parents.some(
          (parent) =>
            parent.kind === "input" || needsDashboardControl(parent.schema.ast),
        ) ||
        nullableParents.some((parent) => parentValue(parent) === null)
      )
        return []
      const whenObjectSupplied = nullableParents
        .filter((parent) => parentValue(parent) === undefined)
        .map((parent) => parent.path.join("."))
      const pendingParent = whenObjectSupplied.length > 0
      const variants = types.filter(
        (variant) => variant._tag !== "Null" && variant._tag !== "Undefined",
      )
      const choiceMetadata =
        annotation(FormRadioInput) ?? annotation(FormCheckboxGroupInput)
      const authoredChoices =
        typeof choiceMetadata === "object" &&
        choiceMetadata !== null &&
        "options" in choiceMetadata &&
        Array.isArray(choiceMetadata.options)
          ? choiceMetadata.options
          : undefined
      const choices =
        authoredChoices ??
        (variants.length === 1 && variants[0]?._tag === "Boolean"
          ? (annotation(FormRequired) === true ? [true] : [true, false]).map(
              (value) => ({ value }),
            )
          : variants.flatMap((variant) =>
              variant._tag === "Literal" && scalar(variant)
                ? [{ value: variant.literal }]
                : [],
            ))
      const supported =
        !dashboardControl &&
        (kind === "container" ||
          annotation(FormCheckboxGroupInput) !== undefined ||
          (variants.length > 0 && variants.every(scalar)))
      const optionalContainerAbsent = parents.some(
        (parent) =>
          parent.kind === "container" &&
          !hasFlattenAnnotation(parent.schema) &&
          !parent.acceptsNull &&
          parentValue(parent) == null &&
          parent.encoded.context?.isOptional === true,
      )
      const required =
        !readOnly &&
        (state.required === true ||
          (!optionalContainerAbsent &&
            !encoded.context?.isOptional &&
            !types.some((member) => member._tag === "Undefined")))
      const dynamic = presentation[target.join(".")]
      const value = valueAt(state.disabled ? originals : defaults, path)
      const provided = valueAt(input, path)
      const name = path.join(".")
      return [
        {
          name,
          label: state.label ?? dynamic?.label ?? annotation(FormLabel) ?? name,
          description: dynamic?.description ?? annotation(FormDescription),
          types: types
            .filter((variant) => variant._tag !== "Undefined")
            .map((variant) => variant._tag),
          choices: acceptsNull ? [...choices, { value: null }] : choices,
          defaultValue:
            (supported && kind !== "container") ||
            (acceptsNull && value === null)
              ? value
              : undefined,
          required: !pendingParent && required,
          ...(pendingParent
            ? { whenObjectSupplied, requiredWhenObjectSupplied: required }
            : {}),
          editable: !readOnly && !state.disabled,
          supported,
          needsDashboard:
            !supported &&
            !readOnly &&
            !state.disabled &&
            !pendingParent &&
            ((required && !acceptsNull) ||
              (provided !== undefined && !(acceptsNull && provided === null))),
        },
      ]
    },
  )
}
