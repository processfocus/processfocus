import {
  type AnyFieldMeta,
  type ValidationLogicProps,
  defaultValidationLogic,
} from "@tanstack/react-form"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import {
  type FormComponent,
  FormComponentType,
} from "@pf/form-client-representation/types"
import { evaluateFormRules } from "@pf/form-rule"
import { useAppForm } from "@pf/shadcn-components"
import { useLocalStorage } from "../hooks/use-local-storage"
import {
  type JsonSchemaRoot,
  createStandardSchemaFromJsonSchema,
} from "./ajv-standard-schema"
import { friendlyFormValidationMessage } from "./friendly-validation-message"
import type { LookupOptions } from "./lookup-context"
import { walkClientRepresentation } from "./walker"

type FormComponentRecord = Readonly<Record<string, FormComponent>>

type ProjectedTargetState = {
  readonly hidden?: boolean
  readonly disabled?: boolean
  readonly required?: boolean
  readonly label?: string
}

const REQUIRED_FIELD_MESSAGE = "This field is required."

const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path)

const pathToFieldName = (path: readonly (string | number)[]): string =>
  path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`
    }
    return result ? `${result}.${segment}` : segment
  }, "")

const fieldNameToPath = (fieldName: string): readonly (string | number)[] => {
  const path: Array<string | number> = []
  const matcher = /([^.[\]]+)|\[(\d+)\]/g
  let match = matcher.exec(fieldName)
  while (match !== null) {
    if (match[1] !== undefined) {
      path.push(match[1])
    } else if (match[2] !== undefined) {
      path.push(Number(match[2]))
    }
    match = matcher.exec(fieldName)
  }
  return path
}

export const initializeFormValues = (
  defaultValues: Record<string, unknown>,
  savedValues: Record<string, unknown>,
): Record<string, unknown> => ({ ...defaultValues, ...savedValues })

const baseComponentStateEntries = (
  components: FormComponentRecord,
): Array<{
  readonly path: readonly (string | number)[]
  readonly state: ProjectedTargetState
}> => {
  const entries: Array<{
    readonly path: readonly (string | number)[]
    readonly state: ProjectedTargetState
  }> = []

  const visit = (
    key: string,
    component: FormComponent,
    parentPath: readonly (string | number)[],
  ) => {
    // Rule targets are authored as form-tree paths. Submitted field names can
    // differ for flattened wrappers, so projection must not key by `field`.
    const path = [...parentPath, key]
    const state = {
      ...(component.hidden !== undefined && { hidden: component.hidden }),
      ...(component.disabled !== undefined && { disabled: component.disabled }),
      ...(component.required !== undefined && { required: component.required }),
      ...(component.label !== undefined && { label: component.label }),
    }
    if (Object.keys(state).length > 0) {
      entries.push({ path, state })
    }

    if (component._tag === FormComponentType.FieldSet) {
      for (const [childKey, child] of Object.entries(component.children)) {
        visit(childKey, child, path)
      }
    }

    if (
      component._tag === FormComponentType.List ||
      component._tag === FormComponentType.Table
    ) {
      for (const [childKey, child] of Object.entries(component.itemChildren)) {
        visit(childKey, child, path)
      }
    }
  }

  for (const [key, component] of Object.entries(components)) {
    visit(key, component, [])
  }

  return entries
}

const projectionStateByPath = (
  formDefinition: ClientFormDefinition,
  values: Record<string, unknown>,
  baseValues: Record<string, unknown> = values,
) => {
  const baseState = baseComponentStateEntries(formDefinition.components)
  const result = evaluateFormRules({
    rules: formDefinition.rules,
    values,
    baseValues,
    baseState,
  })

  return new Map(
    result.targets.map((entry) => [pathKey(entry.path), entry.state]),
  )
}

const withProjectedState = (
  component: FormComponent,
  state:
    | {
        readonly hidden?: boolean
        readonly disabled?: boolean
        readonly required?: boolean
        readonly label?: string
      }
    | undefined,
): FormComponent =>
  ({
    ...component,
    ...(state?.hidden !== undefined && { hidden: state.hidden }),
    ...(state?.disabled !== undefined && { disabled: state.disabled }),
    ...(state?.required !== undefined && { required: state.required }),
    ...(state?.label !== undefined && { label: state.label }),
  }) as FormComponent

const projectFormComponentsWithState = (
  components: FormComponentRecord,
  stateByPath: ReadonlyMap<string, ProjectedTargetState>,
): FormComponentRecord => {
  const project = (
    key: string,
    component: FormComponent,
    parentPath: readonly (string | number)[],
    inheritedHidden: boolean,
    inheritedDisabled: boolean,
  ): FormComponent => {
    const path = [...parentPath, key]
    const projectedState = withProjectedState(
      component,
      stateByPath.get(pathKey(path)),
    )
    const projected = withProjectedState(projectedState, {
      // Apply own rule state first, then let ancestor state win. Structural
      // disabledness intentionally cannot be opted out by child targets.
      ...(inheritedHidden ? { hidden: true } : {}),
      ...(inheritedDisabled ? { disabled: true } : {}),
    })
    const hidden = projected.hidden === true
    const disabled = projected.disabled === true

    if (projected._tag === FormComponentType.FieldSet) {
      return {
        ...projected,
        children: Object.fromEntries(
          Object.entries(projected.children).map(([childKey, child]) => [
            childKey,
            project(childKey, child, path, hidden, disabled),
          ]),
        ),
      }
    }

    if (
      projected._tag === FormComponentType.List ||
      projected._tag === FormComponentType.Table
    ) {
      return {
        ...projected,
        itemChildren: Object.fromEntries(
          Object.entries(projected.itemChildren).map(([childKey, child]) => [
            childKey,
            project(childKey, child, path, hidden, disabled),
          ]),
        ),
      }
    }

    return projected
  }

  return Object.fromEntries(
    Object.entries(components).map(([key, component]) => [
      key,
      project(key, component, [], false, false),
    ]),
  )
}

export const projectFormComponents = (
  formDefinition: ClientFormDefinition,
  values: Record<string, unknown>,
  baseValues: Record<string, unknown> = values,
): FormComponentRecord =>
  projectFormComponentsWithState(
    formDefinition.components,
    projectionStateByPath(formDefinition, values, baseValues),
  )

/**
 * Subset of TanStack Form's AnyFieldMeta that we access in validation logic.
 * This provides a stable interface that won't break if TanStack Form's internal
 * types change, while still maintaining type safety.
 */
type FieldMetaSubset = Pick<
  AnyFieldMeta,
  "isDirty" | "errors" | "isDefaultValue"
>

/**
 * Runtime type guard to validate that a value conforms to FieldMetaSubset.
 * Used defensively when accessing form.state.fieldMeta to ensure the properties
 * we depend on actually exist at runtime.
 */
const isFieldMetaSubset = (meta: unknown): meta is FieldMetaSubset => {
  if (typeof meta !== "object" || meta === null) return false
  const m = meta as Record<string, unknown>
  return (
    "isDirty" in m &&
    typeof m["isDirty"] === "boolean" &&
    "errors" in m &&
    Array.isArray(m["errors"]) &&
    "isDefaultValue" in m &&
    typeof m["isDefaultValue"] === "boolean"
  )
}

/**
 * Helper to safely get fieldMeta as a Record of FieldMetaSubset.
 * Returns undefined if fieldMeta is not available or empty.
 */
const getFieldMetaRecord = (
  fieldMeta: unknown,
): Record<string, FieldMetaSubset> | undefined => {
  if (typeof fieldMeta !== "object" || fieldMeta === null) return undefined
  const record = fieldMeta as Record<string, unknown>
  // Filter to only entries that match our expected shape
  const validEntries = Object.entries(record).filter(([, value]) =>
    isFieldMetaSubset(value),
  )
  if (validEntries.length === 0) return undefined
  return Object.fromEntries(validEntries) as Record<string, FieldMetaSubset>
}

export const getRenderableFieldNames = (
  components: FormComponentRecord,
): Set<string> => {
  const fieldNames = new Set<string>()

  const visit = (component: FormComponent) => {
    switch (component._tag) {
      case FormComponentType.Text:
      case FormComponentType.TextArea:
      case FormComponentType.Number:
      case FormComponentType.Date:
      case FormComponentType.Email:
      case FormComponentType.Phone:
      case FormComponentType.ProviderUser:
      case FormComponentType.Boolean:
      case FormComponentType.Select:
      case FormComponentType.Radio:
      case FormComponentType.File:
      case FormComponentType.Lookup:
      case FormComponentType.CalendarSlot:
      case FormComponentType.List:
      case FormComponentType.Table:
      case FormComponentType.Plugin:
        fieldNames.add(component.field)
        return

      case FormComponentType.FieldSet:
        Object.values(component.children).forEach(visit)
        return

      case FormComponentType.Static:
      case FormComponentType.Link:
      case FormComponentType.MetricBreakdown:
        return

      default: {
        const _exhaustive: never = component
        return _exhaustive
      }
    }
  }

  Object.values(components).forEach(visit)
  return fieldNames
}

const getMetricBreakdownFieldNames = (
  components: FormComponentRecord,
): Set<string> => {
  const fieldNames = new Set<string>()

  const visit = (component: FormComponent) => {
    switch (component._tag) {
      case FormComponentType.FieldSet:
        Object.values(component.children).forEach(visit)
        return

      case FormComponentType.MetricBreakdown:
        fieldNames.add(component.field)
        return

      case FormComponentType.Text:
      case FormComponentType.TextArea:
      case FormComponentType.Number:
      case FormComponentType.Date:
      case FormComponentType.Email:
      case FormComponentType.Phone:
      case FormComponentType.ProviderUser:
      case FormComponentType.Boolean:
      case FormComponentType.Select:
      case FormComponentType.Radio:
      case FormComponentType.File:
      case FormComponentType.Lookup:
      case FormComponentType.CalendarSlot:
      case FormComponentType.List:
      case FormComponentType.Table:
      case FormComponentType.Plugin:
      case FormComponentType.Static:
      case FormComponentType.Link:
        return

      default: {
        const _exhaustive: never = component
        return _exhaustive
      }
    }
  }

  Object.values(components).forEach(visit)
  return fieldNames
}

export const normalizeSubmitErrors = (
  errors: FieldError[],
  renderableFieldNames: Set<string>,
  hiddenFieldNames: Set<string> = new Set(),
): FieldError[] =>
  errors.flatMap((error) => {
    if (hiddenFieldNames.has(error.field)) {
      return []
    }

    const message = friendlyFormValidationMessage(error.message)

    if (error.field === "" || renderableFieldNames.has(error.field)) {
      return [{ ...error, message }]
    }

    return [
      {
        field: "",
        // Preserve the field key for non-rendered fields while still avoiding
        // raw validator wording in the message shown to users.
        message: `${error.field}: ${message}`,
      },
    ]
  })

const collectHiddenFieldNames = (
  components: FormComponentRecord,
): Set<string> => {
  const fieldNames = new Set<string>()

  const visit = (component: FormComponent, inheritedHidden: boolean) => {
    const hidden = inheritedHidden || component.hidden === true
    if ("field" in component && hidden) {
      fieldNames.add(component.field)
    }
    if (component._tag === FormComponentType.FieldSet) {
      for (const child of Object.values(component.children)) {
        visit(child, hidden)
      }
    }
    if (
      component._tag === FormComponentType.List ||
      component._tag === FormComponentType.Table
    ) {
      for (const child of Object.values(component.itemChildren)) {
        visit(child, hidden)
      }
    }
  }

  for (const component of Object.values(components)) {
    visit(component, false)
  }
  return fieldNames
}

const collectRequiredFieldNames = (
  components: FormComponentRecord,
): Set<string> => {
  const fieldNames = new Set<string>()

  const visit = (component: FormComponent, inheritedHidden: boolean) => {
    const hidden = inheritedHidden || component.hidden === true
    if (!hidden && "field" in component && component.required === true) {
      fieldNames.add(component.field)
    }
    if (component._tag === FormComponentType.FieldSet) {
      for (const child of Object.values(component.children)) {
        visit(child, hidden)
      }
    }
    if (
      component._tag === FormComponentType.List ||
      component._tag === FormComponentType.Table
    ) {
      for (const child of Object.values(component.itemChildren)) {
        visit(child, hidden)
      }
    }
  }

  for (const component of Object.values(components)) {
    visit(component, false)
  }
  return fieldNames
}

const collectDisabledFieldNames = (
  components: FormComponentRecord,
): Set<string> => {
  const renderableFieldNames = getRenderableFieldNames(components)
  const fieldNames = new Set<string>()

  const visit = (component: FormComponent, inheritedDisabled: boolean) => {
    const disabled = inheritedDisabled || component.disabled === true
    if (
      "field" in component &&
      disabled &&
      renderableFieldNames.has(component.field)
    ) {
      fieldNames.add(component.field)
    }
    if (component._tag === FormComponentType.FieldSet) {
      for (const child of Object.values(component.children)) {
        visit(child, disabled)
      }
    }
    if (
      component._tag === FormComponentType.List ||
      component._tag === FormComponentType.Table
    ) {
      for (const child of Object.values(component.itemChildren)) {
        visit(child, disabled)
      }
    }
  }

  for (const component of Object.values(components)) {
    visit(component, false)
  }
  return fieldNames
}

const getSchemaProperties = (
  jsonSchema: JsonSchemaRoot,
): Record<string, unknown> | undefined =>
  (jsonSchema as { properties?: Record<string, unknown> }).properties

const getSchemaRequiredFields = (jsonSchema: JsonSchemaRoot): string[] =>
  Array.isArray(jsonSchema["required"])
    ? jsonSchema["required"].filter(
        (field): field is string => typeof field === "string",
      )
    : []

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasSchemaPropertyForField = (
  jsonSchema: JsonSchemaRoot,
  fieldName: string,
): boolean => {
  let currentSchema: unknown = jsonSchema

  for (const segment of fieldNameToPath(fieldName)) {
    if (!isRecord(currentSchema)) return false

    if (typeof segment === "number") {
      if (currentSchema["type"] !== "array") return false
      currentSchema = currentSchema["items"]
      continue
    }

    if (currentSchema["type"] === "array") {
      currentSchema = currentSchema["items"]
      if (!isRecord(currentSchema)) return false
    }

    const schemaProperties = getSchemaProperties(currentSchema)
    if (!schemaProperties || !Object.hasOwn(schemaProperties, segment)) {
      return false
    }
    currentSchema = schemaProperties[segment]
  }

  return true
}

const cloneFormValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(cloneFormValue)
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneFormValue(entry)]),
    )
  }

  return value
}

const deletePathValue = (
  target: unknown,
  path: readonly (string | number)[],
): void => {
  if (path.length === 0) return
  const [segment, ...rest] = path
  if (segment === undefined) return

  if (Array.isArray(target)) {
    if (typeof segment === "number") {
      if (segment >= target.length) return
      if (rest.length === 0) {
        delete target[segment]
        return
      }
      deletePathValue(target[segment], rest)
      return
    }

    for (const item of target) {
      deletePathValue(item, path)
    }
    return
  }

  if (typeof segment === "number" || !isRecord(target)) return
  if (!Object.hasOwn(target, segment)) return
  if (rest.length === 0) {
    delete target[segment]
    return
  }
  deletePathValue(target[segment], rest)
}

const setPathValue = (
  target: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void => {
  if (path.length === 0) return
  const [segment, ...rest] = path
  if (segment === undefined) return

  if (Array.isArray(target)) {
    if (typeof segment === "number") {
      if (segment >= target.length) return
      if (rest.length === 0) {
        target[segment] = cloneFormValue(value)
        return
      }
      setPathValue(target[segment], rest, value)
      return
    }

    for (const item of target) {
      setPathValue(item, path, value)
    }
    return
  }

  if (typeof segment === "number" || !isRecord(target)) return
  if (rest.length === 0) {
    target[segment] = cloneFormValue(value)
    return
  }

  if (!isRecord(target[segment])) {
    target[segment] = {}
  }
  setPathValue(target[segment], rest, value)
}

const getPathValue = (
  values: Record<string, unknown>,
  path: readonly (string | number)[],
): unknown => {
  let current: unknown = values

  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return undefined
      current = current[segment]
      continue
    }

    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

const issuePathToFieldName = (path: readonly unknown[] | undefined) =>
  path === undefined
    ? undefined
    : pathToFieldName(
        path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      )

const filterValuesForSchema = (
  values: Record<string, unknown>,
  jsonSchema: JsonSchemaRoot,
  hiddenFieldNames: Set<string>,
  disabledFieldNames: Set<string>,
  baseValues: Record<string, unknown>,
): Record<string, unknown> => {
  const schemaProperties = getSchemaProperties(jsonSchema)
  if (!schemaProperties) return {}

  const filtered = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key in schemaProperties && !hiddenFieldNames.has(key))
      .map(([key, value]) => [key, cloneFormValue(value)]),
  )

  // Top-level hidden fields are filtered above; nested and list-item child
  // paths are deleted here after their parent objects/arrays have been cloned.
  for (const hiddenFieldName of hiddenFieldNames) {
    deletePathValue(filtered, fieldNameToPath(hiddenFieldName))
  }

  for (const disabledFieldName of disabledFieldNames) {
    if (hiddenFieldNames.has(disabledFieldName)) continue

    const path = fieldNameToPath(disabledFieldName)
    const baseValue = getPathValue(baseValues, path)
    if (baseValue === undefined) {
      deletePathValue(filtered, path)
    } else {
      setPathValue(filtered, path, baseValue)
    }
  }

  return filtered
}

const schemaWithVisibleRequired = (
  jsonSchema: JsonSchemaRoot,
  hiddenFieldNames: Set<string>,
  requiredFieldNames: Set<string>,
): JsonSchemaRoot => {
  const baseRequired = getSchemaRequiredFields(jsonSchema)
  // JSON Schema `required` is scoped to the current object, so only top-level
  // fields can be added here. Nested rule-required fields are enforced by the
  // path-aware manual required check below.
  const required = Array.from(
    new Set([...baseRequired, ...requiredFieldNames]),
  ).filter(
    (field) =>
      !hiddenFieldNames.has(field) &&
      fieldNameToPath(field).length === 1 &&
      hasSchemaPropertyForField(jsonSchema, field),
  )

  if (required.length === 0) {
    const { required: _, ...schemaWithoutRequired } = jsonSchema
    return schemaWithoutRequired
  }

  return { ...jsonSchema, type: "object", required }
}

const isMissingRequiredValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0)

export const createRuleAwareValidator = (
  jsonSchema: JsonSchemaRoot,
  formDefinition: ClientFormDefinition,
  baseValues: Record<string, unknown>,
) => ({
  "~standard": {
    version: 1 as const,
    vendor: "pf-form-rule",
    validate: (value: unknown) => {
      const values =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      const stateByPath = projectionStateByPath(
        formDefinition,
        values,
        baseValues,
      )
      const projectedComponents = projectFormComponentsWithState(
        formDefinition.components,
        stateByPath,
      )
      const hiddenFieldNames = collectHiddenFieldNames(projectedComponents)
      const disabledFieldNames = collectDisabledFieldNames(projectedComponents)
      // Required fields are collected after projection so inherited hiddenness
      // can suppress descendants before validation runs.
      const projectedRequiredFieldNames =
        collectRequiredFieldNames(projectedComponents)
      const requiredFieldNames = new Set(
        [
          ...getSchemaRequiredFields(jsonSchema),
          ...Array.from(projectedRequiredFieldNames).filter((fieldName) =>
            hasSchemaPropertyForField(jsonSchema, fieldName),
          ),
        ].filter((fieldName) => !hiddenFieldNames.has(fieldName)),
      )
      const visibleValues = filterValuesForSchema(
        values,
        jsonSchema,
        hiddenFieldNames,
        disabledFieldNames,
        baseValues,
      )
      const schemaValidator = createStandardSchemaFromJsonSchema(
        schemaWithVisibleRequired(
          jsonSchema,
          hiddenFieldNames,
          requiredFieldNames,
        ),
      )
      const result = schemaValidator["~standard"].validate(visibleValues)
      const issues =
        "issues" in result && result.issues ? [...result.issues] : []

      for (const fieldName of requiredFieldNames) {
        const fieldPath = fieldNameToPath(fieldName)
        const hasRequiredIssue = issues.some(
          (issue) =>
            issuePathToFieldName(issue.path) === fieldName &&
            issue.message === REQUIRED_FIELD_MESSAGE,
        )
        const fieldValue = getPathValue(visibleValues, fieldPath)
        // JSON Schema checks whether null is allowed. Its `required` keyword
        // requires presence only; an explicit Form Rule may additionally require
        // a nonempty value.
        if (
          fieldValue === null &&
          !projectedRequiredFieldNames.has(fieldName)
        ) {
          continue
        }
        if (!hasRequiredIssue && isMissingRequiredValue(fieldValue)) {
          issues.push({
            path: fieldPath,
            message: REQUIRED_FIELD_MESSAGE,
          })
        }
      }

      return issues.length > 0 ? { issues } : { value: visibleValues }
    },
  },
})

/**
 * Focus the first field with an error using DOM querySelector
 * @see https://tanstack.com/form/v1/docs/framework/react/guides/focus-management
 */
const focusFirstErrorField = (fieldName: string) => {
  // Use requestAnimationFrame to ensure DOM has updated with error state
  // This waits for the next browser paint cycle, which is more reliable than setTimeout
  requestAnimationFrame(() => {
    // Try to find input by name attribute
    const input = document.querySelector<HTMLInputElement>(
      `input[name="${fieldName}"], textarea[name="${fieldName}"], select[name="${fieldName}"]`,
    )

    if (input) {
      input.focus()
      input.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  })
}

const firstEditableControlSelector = [
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  "textarea:not([disabled]):not([readonly])",
  "select:not([disabled])",
  'button[role="combobox"]:not([disabled])',
].join(",")

const focusFirstEditableControl = (formElement: HTMLFormElement) => {
  if (formElement.contains(document.activeElement)) return undefined

  let timerId: number | undefined
  const frameId = requestAnimationFrame(() => {
    timerId = window.setTimeout(() => {
      if (formElement.contains(document.activeElement)) return

      const control = formElement.querySelector<HTMLElement>(
        firstEditableControlSelector,
      )
      control?.focus()
    }, 0)
  })

  return () => {
    cancelAnimationFrame(frameId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
    }
  }
}

// Type alias for forms with our schema validator configuration
// This didn't really work well as forms and fields start to show up as any
//type AnyAppForm = AppFieldExtendedReactFormApi<unknown, FormValidateOrFn<unknown> | undefined, StandardSchemaV1<object, object> | undefined, any, any, any, any, any, any, any, any, any, any, any>
// So we use this, somewhat generic but working well enough.
type AnyAppForm = ReturnType<typeof useAppForm>

/**
 * Custom validation logic for dynamic form fields.
 *
 * Improves UX over revalidateLogic by:
 * - Skipping blur validation on non-dirty fields (prevents errors on tab-through)
 * - Re-validating on change when field already has errors (clears errors as user types)
 * - Always validating on submit
 * - Always validating after first submission attempt (same as revalidateLogic)
 *
 * Type Safety Note:
 * The function is cast to ValidationLogicFn at the end because TanStack Form's type
 * definition declares this as returning void. However, internally TanStack Form's
 * getSyncValidatorArray relies on the return value flowing through from runValidation.
 * This matches the pattern used by revalidateLogic in the TanStack Form source.
 * The cast is necessary to satisfy TypeScript while preserving the runtime behavior
 * that TanStack Form expects.
 */
export const customValidationLogic = ((props: ValidationLogicProps) => {
  const { form, validators, event, runValidation } = props

  const validatorKeys = Object.keys(validators ?? {})
  if (validatorKeys.length === 0) {
    return runValidation({ validators: [], form })
  }

  type Validator = Parameters<
    ValidationLogicProps["runValidation"]
  >[0]["validators"][number]

  const validatorFn = event.async
    ? validators?.["onDynamicAsync"]
    : validators?.["onDynamic"]

  if (!validatorFn) {
    return runValidation({ validators: [], form })
  }

  const dynamicValidator: Validator = {
    fn: validatorFn,
    cause: "dynamic" as const,
  }

  // Collect default validators from defaultValidationLogic
  let defaultValidators: Validator[] = []
  defaultValidationLogic({
    ...props,
    runValidation: (vProps) => {
      defaultValidators = vProps.validators
    },
  })

  const afterSubmission = form.state.submissionAttempts > 0
  let includeDynamic = false

  switch (event.type) {
    case "submit": {
      // Always validate on submit
      includeDynamic = true
      break
    }
    case "blur": {
      if (afterSubmission) {
        // After submission: always validate on blur
        includeDynamic = true
      } else {
        // Before submission: only validate if any field has been modified (prevents #1)
        const fieldMeta = getFieldMetaRecord(form.state.fieldMeta)
        includeDynamic = fieldMeta
          ? Object.values(fieldMeta).some((m) => m.isDirty)
          : false
      }
      break
    }
    case "change": {
      if (afterSubmission) {
        // After submission: always validate on change
        includeDynamic = true
      } else {
        // Before submission: only re-validate when a dirty field has errors (fixes #4, #5).
        // Fields at their default value may have stale errors from a previous editing cycle;
        // those should not trigger re-validation so the field behaves as untouched.
        const fieldMeta = getFieldMetaRecord(form.state.fieldMeta)
        includeDynamic = fieldMeta
          ? Object.values(fieldMeta).some(
              (m) => m.errors.length > 0 && !m.isDefaultValue,
            )
          : false
      }
      break
    }
    default: {
      // mount, server — do not add dynamic validator
      includeDynamic = false
    }
  }

  if (includeDynamic) {
    return runValidation({
      validators: [...defaultValidators, dynamicValidator],
      form,
    })
  }

  // For blur/change: clear stale onDynamic errors with a no-op validator.
  // This mirrors how defaultValidationLogic clears onServer errors using () => undefined.
  // Without this, errors from a previous validation cycle persist in errorMap.onDynamic.
  if (event.type === "blur" || event.type === "change") {
    const clearDynamic: Validator = {
      fn: () => undefined,
      cause: "dynamic" as const,
    }
    return runValidation({
      validators: [...defaultValidators, clearDynamic],
      form,
    })
  }

  return runValidation({ validators: defaultValidators, form })
  // Cast: ValidationLogicFn type declares void, but TanStack Form internally
  // relies on the return value. Required to match revalidateLogic pattern.
}) as (props: ValidationLogicProps) => void

/**
 * Field-level or form-level validation error returned from handleSubmit.
 * Use field: "" (empty string) for form-level errors that apply to the entire form.
 */
export interface FieldError {
  field: string
  message: string
}

/**
 * Context passed to the renderActions callback.
 * Provides form state and utilities for rendering custom action buttons.
 *
 * Note: Submit button should only be disabled during `isSubmitting`.
 * Validation errors are shown inline after the user presses submit,
 * per Web Interface Guidelines: "Submit button stays enabled until
 * request starts; spinner during request."
 */
export interface FormActionsContext {
  /** Current form state */
  readonly formState: {
    readonly values: Record<string, unknown>
    readonly isSubmitting: boolean
    readonly isPristine: boolean
  }
  /** Clear the session-level localStorage for this form */
  readonly clearLocalStorage: () => void
}

/**
 * Properties for the dynamic form component.
 *
 * The handleSubmit callback should return:
 * - undefined/void for successful submission
 * - FieldError[] for validation errors that should be set on form fields
 */
export interface FormProperties {
  /** Unique ID for localStorage session state */
  readonly draftId: string
  readonly formDefinition: ClientFormDefinition | null
  readonly defaultValues: Record<string, unknown> | null
  readonly handleCancel?: () => void
  readonly handleSubmit: (
    values: Record<string, unknown>,
  ) => Promise<FieldError[] | undefined>
  readonly jsonSchema: JsonSchemaRoot | null

  /**
   * Render custom action buttons (Discard, Save draft, Submit, etc.)
   * Called inside form.Subscribe with current form state.
   */
  readonly renderActions: (context: FormActionsContext) => React.ReactNode

  /**
   * Step path for authenticated field actions.
   * Required when the form contains file upload fields, lookup fields, or
   * provider-user fields with enableProviderUserLookup set to true.
   */
  readonly stepPath?: string

  /** Enables authenticated provider-user suggestions. Disable for embeds. */
  readonly enableProviderUserLookup?: boolean

  /** Optional state context for lookup queries, such as a to-do being completed. */
  readonly lookupOptions?: LookupOptions | undefined

  /** Debounce for session localStorage draft writes. Defaults to 500ms. */
  readonly onChangeDebounceMs?: number
}

/**
 * Simple form for steps with no input fields.
 * Renders action buttons via renderActions callback.
 */
const SimpleForm = ({
  onSubmit,
  renderActions,
}: {
  onSubmit: (
    values: Record<string, unknown>,
  ) => Promise<FieldError[] | undefined>
  renderActions: (context: FormActionsContext) => React.ReactNode
}) => {
  const form = useAppForm({
    defaultValues: {},
    onSubmit: async () => {
      await onSubmit({})
    },
  })

  // Form instance is stable across renders
  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      form.handleSubmit()
    },
    [form],
  )

  return (
    <form className="space-y-6" onSubmit={handleFormSubmit}>
      <form.Subscribe
        selector={(state) => [state.isSubmitting, state.isPristine] as const}
      >
        {([isSubmitting, isPristine]) => {
          const context: FormActionsContext = {
            formState: {
              values: {},
              isSubmitting,
              isPristine,
            },
            clearLocalStorage: () => {
              /* no-op for simple forms */
            },
          }
          return renderActions(context)
        }}
      </form.Subscribe>
    </form>
  )
}

/**
 * Properties for the full form component (non-null values).
 */
interface FullFormProperties {
  readonly draftId: string
  readonly formDefinition: ClientFormDefinition
  readonly defaultValues: Record<string, unknown>
  readonly onSubmit: (
    values: Record<string, unknown>,
  ) => Promise<FieldError[] | undefined>
  readonly jsonSchema: JsonSchemaRoot
  readonly renderActions: (context: FormActionsContext) => React.ReactNode
  readonly stepPath: string | undefined
  readonly enableProviderUserLookup: boolean
  readonly lookupOptions: LookupOptions | undefined
  readonly onChangeDebounceMs: number
}

/**
 * Full form component with all hooks.
 * Only rendered when we have all required data (non-null).
 */
const FullForm = ({
  draftId,
  formDefinition,
  defaultValues,
  onSubmit,
  jsonSchema,
  renderActions,
  stepPath,
  enableProviderUserLookup,
  lookupOptions,
  onChangeDebounceMs,
}: FullFormProperties) => {
  const formRef = useRef<HTMLFormElement | null>(null)
  const hasSubmittedSuccessfully = useRef(false)
  const [formValues, setFormValues, clearFormValues] = useLocalStorage<
    Record<string, unknown>
  >(draftId, {})

  // Snapshot initial values once for this form instance. Saved values take precedence,
  // and defaultValues may already include draft state from RxDB.
  const [initialValues] = useState(() =>
    initializeFormValues(defaultValues, formValues),
  )

  const baseComponents = formDefinition.components

  // Create Standard Schema validator from JSON Schema if provided
  const validator = useMemo(
    () => createRuleAwareValidator(jsonSchema, formDefinition, defaultValues),
    [jsonSchema, formDefinition, defaultValues],
  )

  // Track form-level errors (server-returned errors with field: "")
  const [formLevelErrors, setFormLevelErrors] = useState<string[]>([])
  const renderableFieldNames = useMemo(
    () => getRenderableFieldNames(baseComponents),
    [baseComponents],
  )
  const metricBreakdownFieldNames = useMemo(
    () => getMetricBreakdownFieldNames(baseComponents),
    [baseComponents],
  )

  const form = useAppForm({
    defaultValues: initialValues,
    validators: {
      onDynamic: validator,
    },
    validationLogic: customValidationLogic,
    onSubmit: async ({ value }) => {
      // Clear previous submit errors from all fields and form level
      setFormLevelErrors([])
      renderableFieldNames.forEach((fieldName) => {
        form.setFieldMeta(fieldName, (prev) => ({
          ...prev,
          errorMap: { ...(prev?.errorMap ?? {}), onSubmit: undefined },
        }))
      })

      const projectedComponents = projectFormComponents(
        formDefinition,
        value,
        defaultValues,
      )
      const hiddenFieldNames = collectHiddenFieldNames(projectedComponents)
      const disabledFieldNames = collectDisabledFieldNames(projectedComponents)
      const filteredValue = filterValuesForSchema(
        value,
        jsonSchema,
        hiddenFieldNames,
        disabledFieldNames,
        defaultValues,
      )

      // Call the user's submit handler and capture any field errors
      const fieldErrors = await onSubmit(filteredValue)
      const normalizedFieldErrors = fieldErrors
        ? normalizeSubmitErrors(
            fieldErrors,
            renderableFieldNames,
            hiddenFieldNames,
          )
        : undefined

      // If there are errors, separate form-level from field-level
      if (normalizedFieldErrors && normalizedFieldErrors.length > 0) {
        const formErrors: string[] = []
        const fieldSpecificErrors: FieldError[] = []

        for (const error of normalizedFieldErrors) {
          if (error.field === "") {
            // Form-level error
            formErrors.push(error.message)
          } else {
            // Field-specific error
            fieldSpecificErrors.push(error)
          }
        }

        // Set form-level errors
        if (formErrors.length > 0) {
          setFormLevelErrors(formErrors)
        }

        // Set field-specific errors
        for (const error of fieldSpecificErrors) {
          form.setFieldMeta(error.field, (prev) => ({
            ...prev,
            errorMap: { ...(prev?.errorMap ?? {}), onSubmit: error.message },
          }))
        }

        // Focus first field with error (if any)
        const firstErrorField = fieldSpecificErrors[0]?.field
        if (firstErrorField) {
          focusFirstErrorField(firstErrorField)
        }
        return
      }

      // Success - clear the form from localStorage
      // Note: Caller's handleSubmit should handle RxDB draft cleanup
      // Debounced listeners can still run while the caller navigates away.
      hasSubmittedSuccessfully.current = true
      clearFormValues()
    },
    onSubmitInvalid: () => {
      // Focus first field with validation error so user knows what to fix
      requestAnimationFrame(() => {
        const fieldMeta = getFieldMetaRecord(form.state.fieldMeta)
        if (!fieldMeta) return
        const firstErrorField = Object.entries(fieldMeta).find(
          ([, meta]) => meta.errors.length > 0,
        )?.[0]
        if (firstErrorField) {
          focusFirstErrorField(firstErrorField)
        }
      })
    },
    listeners: {
      // Save form state to localStorage on any change
      onChange: () => {
        if (hasSubmittedSuccessfully.current) return
        setFormValues(form.state.values)
      },
      // Debounce to avoid excessive localStorage writes
      onChangeDebounceMs,
    },
  })

  useEffect(() => {
    for (const fieldName of metricBreakdownFieldNames) {
      if (fieldName in defaultValues) {
        form.setFieldValue(fieldName, defaultValues[fieldName])
      }
    }
  }, [defaultValues, metricBreakdownFieldNames, form.setFieldValue])

  useEffect(() => {
    const formElement = formRef.current
    if (!formElement) return
    return focusFirstEditableControl(formElement)
  }, [])

  // Form instance is stable across renders (useState), so form.handleSubmit
  // method reference is also stable.
  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      form.handleSubmit()
    },
    [form],
  )

  return (
    <form ref={formRef} className="space-y-6" onSubmit={handleFormSubmit}>
      <form.AppForm>
        {/* Rule projection must respond to every value change so hidden, disabled, and required state stays local and immediate. */}
        <form.Subscribe selector={(state) => state.values}>
          {(values) =>
            walkClientRepresentation(
              form as unknown as AnyAppForm,
              projectFormComponents(formDefinition, values, defaultValues),
              true,
              stepPath,
              enableProviderUserLookup,
              lookupOptions,
            )
          }
        </form.Subscribe>
        {formLevelErrors.length > 0 && (
          <div
            className="rounded-md bg-red-50 p-4 dark:bg-red-900/20"
            aria-live="polite"
          >
            <div className="flex">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-red-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                  {formLevelErrors.length === 1
                    ? "An error occurred"
                    : "There were errors with your submission"}
                </h3>
                <div className="mt-2 text-sm text-red-700 dark:text-red-300">
                  <ul className="list-disc space-y-1 pl-5">
                    {formLevelErrors.map((error) => (
                      <li key={`form-${error}`}>{error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
        <form.Subscribe
          selector={(state) =>
            [state.isSubmitting, state.isPristine, state.values] as const
          }
        >
          {([isSubmitting, isPristine, values]) => {
            const context: FormActionsContext = {
              formState: {
                values,
                isSubmitting,
                isPristine,
              },
              clearLocalStorage: clearFormValues,
            }
            return renderActions(context)
          }}
        </form.Subscribe>
      </form.AppForm>
    </form>
  )
}

/**
 * Main form entry point.
 *
 * Client representation-based form that receives pre-computed form structure from server.
 * Action buttons are rendered via the renderActions callback to allow callers to customize.
 *
 * Delegates to SimpleForm for steps with no input fields, or FullForm otherwise.
 */
export const dynamicForm = (props: FormProperties) => {
  const {
    draftId,
    formDefinition,
    defaultValues,
    handleSubmit: onSubmit,
    jsonSchema,
    renderActions,
    stepPath,
    enableProviderUserLookup = true,
    lookupOptions,
    onChangeDebounceMs = 500,
  } = props

  // Handle steps with no input fields - return simple form
  if (
    jsonSchema === null ||
    formDefinition === null ||
    defaultValues === null
  ) {
    return <SimpleForm onSubmit={onSubmit} renderActions={renderActions} />
  }

  // Render full form with all hooks
  return (
    <FullForm
      draftId={draftId}
      formDefinition={formDefinition}
      defaultValues={defaultValues}
      onSubmit={onSubmit}
      jsonSchema={jsonSchema}
      renderActions={renderActions}
      stepPath={stepPath}
      enableProviderUserLookup={enableProviderUserLookup}
      lookupOptions={lookupOptions}
      onChangeDebounceMs={onChangeDebounceMs}
    />
  )
}
