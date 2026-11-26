import { Result, Schema, SchemaAST } from "effect"
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
  type FormRequestData,
  FormSuggestionInput,
  fieldAnnotation,
} from "@pf/form-schema"
import {
  executableFields,
  extractValidationErrors,
  prepareExecutableSubmission,
  submissionSchemaSync,
  toFormJsonSchema,
} from "@pf/form-submission-schema"
import { mergeFormDefaults } from "@pf/process"

const dashboardFields = [
  FormCalendarSlotInput,
  FormComponentPluginType,
  FormFileInput,
  FormLookupInput,
  FormProviderUserInput,
  FormSuggestionInput,
]

const chatValue = (ast: SchemaAST.AST): boolean => {
  switch (ast._tag) {
    case "Undefined":
    case "Null":
    case "String":
    case "Number":
    case "Boolean":
    case "Literal":
      return true
    case "Union":
      return ast.types.every(chatValue)
    case "Arrays":
      return [...ast.elements, ...ast.rest].every(chatValue)
    default:
      return false
  }
}

const valueAt = (record: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null && Object.hasOwn(value, key)
        ? Reflect.get(value, key)
        : undefined,
    record,
  )

export const projectProcessStartForm = ({
  schema,
  defaults,
  requestData,
  input,
}: {
  schema: Parameters<typeof executableFields>[0]
  defaults: Record<string, unknown>
  requestData: FormRequestData
  input: Record<string, unknown>
}) => {
  const { inaccessible, originalValues, presentation } = requestData
  const draft = mergeFormDefaults(defaults, input)
  const prepared = prepareExecutableSubmission(
    schema,
    draft,
    originalValues,
    inaccessible,
  )
  const unsupportedPaths: string[] = []
  const unconfirmedDefaults: string[] = []
  let requiresDashboard = false
  const evaluated = executableFields(
    schema,
    draft,
    inaccessible,
    originalValues,
  )
  const fields = evaluated
    .filter(({ kind, state }) => kind === "input" && !state.hidden)
    .flatMap(({ schema: field, path, target, state }) => {
      const name = path.join(".")
      if (unsupportedPaths.some((parent) => name.startsWith(`${parent}.`)))
        return []
      const annotation = (key: symbol) => fieldAnnotation(field.ast, key)
      const authored = presentation[target.join(".")]
      const encoded = SchemaAST.toEncoded(field.ast)
      const supported =
        !dashboardFields.some((key) => annotation(key) !== undefined) &&
        chatValue(encoded)
      const required =
        state.required ??
        (!encoded.context?.isOptional &&
          !(
            encoded._tag === "Union" &&
            encoded.types.some(
              (type) => type._tag === "Undefined" || type._tag === "Null",
            )
          ))
      if (!supported) {
        unsupportedPaths.push(name)
        // An editable default would be submitted even if the caller omitted
        // the field. Chat cannot confirm a value it cannot submit.
        if (
          required ||
          valueAt(input, path) !== undefined ||
          (!state.disabled && valueAt(defaults, path) !== undefined)
        )
          requiresDashboard = true
      } else if (
        !state.disabled &&
        valueAt(defaults, path) !== undefined &&
        valueAt(input, path) === undefined
      ) {
        unconfirmedDefaults.push(name)
      }
      const choices =
        annotation(FormRadioInput) ?? annotation(FormCheckboxGroupInput)
      return [
        {
          path,
          label:
            state.label ?? authored?.label ?? annotation(FormLabel) ?? name,
          description: authored?.description ?? annotation(FormDescription),
          required,
          disabled: state.disabled ?? false,
          supported,
          ...(supported
            ? {
                schema: toFormJsonSchema(field),
                ...(typeof choices === "object" &&
                choices !== null &&
                "options" in choices
                  ? { choices: choices.options }
                  : {}),
              }
            : {}),
        },
      ]
    })
  // The shared browser schema has no backend bindings; those run on submit.
  const portable = Schema.make<Schema.Codec<unknown, unknown>>(
    submissionSchemaSync(schema).ast,
  )
  const validation = Schema.decodeUnknownResult(portable, {
    errors: "all",
    onExcessProperty: "error",
  })(prepared.values)
  const errors = [...prepared.errors]
  if (Result.isFailure(validation))
    for (const error of extractValidationErrors(validation.failure))
      if (
        !errors.some(({ field }) => field === error.field) &&
        !evaluated.some(
          ({ path, state }) =>
            state.hidden &&
            path.length > 0 &&
            (error.field === path.join(".") ||
              error.field.startsWith(`${path.join(".")}.`)),
        )
      )
        errors.push(error)
  return {
    fields,
    errors,
    requiresDashboard:
      requiresDashboard ||
      errors.some(({ field }) =>
        unsupportedPaths.some(
          (path) => path === field || field.startsWith(`${path}.`),
        ),
      ),
    unconfirmedDefaults,
    submissionInput: draft,
  }
}
