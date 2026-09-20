import {
  type FormRule,
  type FormRuleExpression,
  type RuleValue,
  formRuleReferencesFieldNames,
} from "@pf/form-rule"
import { type FormComponent, FormComponentType } from "./types"

export interface ClientFormDefinition {
  readonly components: Readonly<Record<string, FormComponent>>
  readonly rules: readonly FormRule[]
}

const MAX_FORM_COMPONENT_DEPTH = 20

const omitFormComponents = (
  components: Readonly<Record<string, FormComponent>>,
  omittedFieldNames: ReadonlySet<string>,
  depth = 0,
): Record<string, FormComponent> => {
  if (depth > MAX_FORM_COMPONENT_DEPTH) {
    return {}
  }

  const visible: Record<string, FormComponent> = {}
  for (const [componentName, component] of Object.entries(components)) {
    if (omittedFieldNames.has(componentName)) continue
    if ("field" in component && omittedFieldNames.has(component.field)) continue

    if (component._tag === FormComponentType.FieldSet) {
      visible[componentName] = {
        ...component,
        children: omitFormComponents(
          component.children,
          omittedFieldNames,
          depth + 1,
        ),
      }
      continue
    }

    if (
      component._tag === FormComponentType.List ||
      component._tag === FormComponentType.Table
    ) {
      visible[componentName] = {
        ...component,
        itemChildren: omitFormComponents(
          component.itemChildren,
          omittedFieldNames,
          depth + 1,
        ),
      }
      continue
    }

    visible[componentName] = component
  }

  return visible
}

/**
 * Projects a definition through an already-authorized field set. A rule is
 * removed as a unit when any condition, effect, or otherwise path references
 * an omitted field.
 */
export const omitClientFormDefinitionFields = (
  definition: ClientFormDefinition,
  omittedFieldNames: ReadonlySet<string>,
): ClientFormDefinition => {
  if (omittedFieldNames.size === 0) return definition

  return {
    components: omitFormComponents(definition.components, omittedFieldNames),
    rules: definition.rules.filter(
      (rule) =>
        !formRuleReferencesFieldNames({
          rule,
          fieldNames: omittedFieldNames,
        }),
    ),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string"

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === "boolean"

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const hasBaseComponentFields = (
  component: Record<string, unknown>,
  labelRequired = true,
): boolean =>
  (labelRequired
    ? typeof component["label"] === "string"
    : isOptionalString(component["label"])) &&
  isOptionalString(component["description"]) &&
  isOptionalBoolean(component["readonly"]) &&
  isOptionalBoolean(component["disabled"]) &&
  isOptionalBoolean(component["hidden"]) &&
  isOptionalBoolean(component["required"]) &&
  (component["permission"] === undefined ||
    (isRecord(component["permission"]) &&
      typeof component["permission"]["modify"] === "string"))

const hasFormFieldFields = (component: Record<string, unknown>): boolean =>
  hasBaseComponentFields(component) &&
  typeof component["field"] === "string" &&
  isOptionalString(component["autoComplete"])

const isFormComponentRecord = (
  value: unknown,
): value is Record<string, FormComponent> =>
  isRecord(value) && Object.values(value).every(isFormComponent)

const isRadioOptions = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (option) =>
      isRecord(option) &&
      typeof option["value"] === "string" &&
      typeof option["label"] === "string",
  )

const isCalendarMetadata = (value: unknown): boolean => {
  if (!isRecord(value)) return false

  const isWeekday = (weekday: unknown): boolean =>
    typeof weekday === "number" &&
    Number.isInteger(weekday) &&
    weekday >= 0 &&
    weekday <= 6

  return (
    (value["weekStartsOn"] === undefined || isWeekday(value["weekStartsOn"])) &&
    (value["businessDays"] === undefined ||
      (Array.isArray(value["businessDays"]) &&
        value["businessDays"].every(isWeekday)))
  )
}

const isPluginScripts = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (script) =>
      isRecord(script) &&
      typeof script["id"] === "string" &&
      typeof script["src"] === "string" &&
      isOptionalBoolean(script["async"]) &&
      isOptionalBoolean(script["defer"]),
  )

const metricColors = new Set([
  "amber",
  "emerald",
  "rose",
  "sky",
  "slate",
  "violet",
])

const hasOptionalMetricColor = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && metricColors.has(value))

const isMetricBuckets = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (bucket) =>
      isRecord(bucket) &&
      typeof bucket["label"] === "string" &&
      (bucket["amount"] === undefined ||
        (typeof bucket["amount"] === "number" &&
          Number.isFinite(bucket["amount"]))) &&
      isOptionalString(bucket["description"]) &&
      hasOptionalMetricColor(bucket["color"]),
  )

const isMetricFields = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (field) =>
      isRecord(field) &&
      typeof field["label"] === "string" &&
      isOptionalString(field["value"]),
  )

const isMetricControls = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (control) =>
      isRecord(control) &&
      control["type"] === "selector" &&
      typeof control["name"] === "string" &&
      isOptionalString(control["urlParameter"]) &&
      typeof control["label"] === "string" &&
      isOptionalString(control["value"]) &&
      Array.isArray(control["options"]) &&
      control["options"].length > 0 &&
      control["options"].every(
        (option) =>
          isRecord(option) &&
          typeof option["label"] === "string" &&
          typeof option["value"] === "string",
      ),
  )

/** Browser-safe structural validation for form component JSON. */
export const isFormComponent = (value: unknown): value is FormComponent => {
  if (!isRecord(value) || typeof value["_tag"] !== "string") return false

  switch (value["_tag"]) {
    case FormComponentType.Text:
    case FormComponentType.TextArea:
    case FormComponentType.Number:
    case FormComponentType.Date:
    case FormComponentType.Email:
    case FormComponentType.Phone:
    case FormComponentType.ProviderUser:
    case FormComponentType.Boolean:
      return hasFormFieldFields(value)
    case FormComponentType.Select:
      return (
        hasFormFieldFields(value) &&
        Array.isArray(value["options"]) &&
        value["options"].length > 0 &&
        (value["emptyValue"] === undefined ||
          value["emptyValue"] === "null" ||
          value["emptyValue"] === "undefined") &&
        value["options"].every((option: unknown) => typeof option === "string")
      )
    case FormComponentType.Radio:
      return hasFormFieldFields(value) && isRadioOptions(value["options"])
    case FormComponentType.File:
      return (
        hasFormFieldFields(value) &&
        typeof value["documentStore"] === "string" &&
        isOptionalString(value["accept"]) &&
        (value["maxSize"] === undefined ||
          (typeof value["maxSize"] === "number" &&
            Number.isFinite(value["maxSize"])))
      )
    case FormComponentType.FieldSet:
      return (
        hasBaseComponentFields(value) &&
        isFormComponentRecord(value["children"])
      )
    case FormComponentType.Lookup:
      return (
        hasFormFieldFields(value) &&
        (value["dependencies"] === undefined ||
          isStringArray(value["dependencies"])) &&
        isOptionalString(value["queryName"]) &&
        isOptionalBoolean(value["allowFreeText"])
      )
    case FormComponentType.CalendarSlot:
      return (
        hasFormFieldFields(value) &&
        typeof value["timeZone"] === "string" &&
        typeof value["locale"] === "string" &&
        (value["calendar"] === undefined ||
          isCalendarMetadata(value["calendar"])) &&
        isOptionalString(value["emptyMessageHtml"]) &&
        isOptionalString(value["loadErrorMessageHtml"])
      )
    case FormComponentType.Plugin:
      return (
        hasFormFieldFields(value) &&
        typeof value["pluginType"] === "string" &&
        (value["scripts"] === undefined || isPluginScripts(value["scripts"]))
      )
    case FormComponentType.List:
      return (
        hasBaseComponentFields(value) &&
        typeof value["field"] === "string" &&
        isOptionalString(value["addButtonLabel"]) &&
        isFormComponentRecord(value["itemChildren"])
      )
    case FormComponentType.Table:
      return (
        hasBaseComponentFields(value) &&
        typeof value["field"] === "string" &&
        isFormComponentRecord(value["itemChildren"])
      )
    case FormComponentType.Static:
      return (
        hasBaseComponentFields(value) &&
        typeof value["field"] === "string" &&
        isOptionalString(value["content"])
      )
    case FormComponentType.Link:
      return (
        hasBaseComponentFields(value, false) &&
        typeof value["field"] === "string" &&
        typeof value["url"] === "string" &&
        typeof value["text"] === "string" &&
        (value["display"] === undefined || value["display"] === "button") &&
        (value["color"] === undefined || value["color"] === "blue")
      )
    case FormComponentType.MetricBreakdown:
      return (
        hasBaseComponentFields(value) &&
        typeof value["field"] === "string" &&
        typeof value["title"] === "string" &&
        isMetricBuckets(value["buckets"]) &&
        isOptionalString(value["badge"]) &&
        isOptionalString(value["currency"]) &&
        (value["fields"] === undefined || isMetricFields(value["fields"])) &&
        (value["controls"] === undefined ||
          isMetricControls(value["controls"])) &&
        (value["contextFields"] === undefined ||
          isStringArray(value["contextFields"])) &&
        (value["dataSource"] === undefined || value["dataSource"] === "item") &&
        isOptionalString(value["rendererPluginType"]) &&
        (value["rendererPluginData"] === undefined ||
          isRecord(value["rendererPluginData"]))
      )
    default:
      return false
  }
}

const isFormRuleLiteral = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(isFormRuleLiteral))

const isFormRulePath = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (segment) => typeof segment === "string" || typeof segment === "number",
  )

const isRuleValue = (value: unknown): value is RuleValue => {
  if (!isRecord(value)) return false

  switch (value["_tag"]) {
    case "literal":
      return isFormRuleLiteral(value["value"])
    case "field":
      return (
        isFormRulePath(value["path"]) &&
        (value["source"] === undefined ||
          value["source"] === "current" ||
          value["source"] === "base")
      )
    default:
      return false
  }
}

const isFormRuleExpression = (value: unknown): value is FormRuleExpression => {
  if (!isRecord(value)) return false

  switch (value["_tag"]) {
    case "equals":
    case "notEquals":
      return isRuleValue(value["left"]) && isRuleValue(value["right"])
    case "in":
    case "notIn":
      return isRuleValue(value["value"]) && isRuleValue(value["candidates"])
    case "blank":
    case "present":
      return isRuleValue(value["value"])
    case "and":
    case "or":
      return (
        Array.isArray(value["expressions"]) &&
        value["expressions"].every(isFormRuleExpression)
      )
    case "not":
      return isFormRuleExpression(value["expression"])
    case "numberOrder":
    case "stringOrder":
    case "dateOrder":
      return (
        (value["operator"] === "lt" ||
          value["operator"] === "lte" ||
          value["operator"] === "gt" ||
          value["operator"] === "gte") &&
        isRuleValue(value["left"]) &&
        isRuleValue(value["right"])
      )
    default:
      return false
  }
}

const isFormRuleEffect = (value: unknown): boolean =>
  isRecord(value) &&
  isFormRulePath(value["target"]) &&
  isRecord(value["state"]) &&
  isOptionalBoolean(value["state"]["hidden"]) &&
  isOptionalBoolean(value["state"]["disabled"]) &&
  isOptionalBoolean(value["state"]["required"]) &&
  isOptionalString(value["state"]["label"])

const isFormRule = (value: unknown): value is FormRule =>
  isRecord(value) &&
  isFormRuleExpression(value["condition"]) &&
  Array.isArray(value["effects"]) &&
  value["effects"].every(isFormRuleEffect) &&
  (value["otherwise"] === undefined ||
    (Array.isArray(value["otherwise"]) &&
      value["otherwise"].every(isFormRuleEffect)))

export const isClientFormDefinition = (
  value: unknown,
): value is ClientFormDefinition =>
  isRecord(value) &&
  isFormComponentRecord(value["components"]) &&
  Array.isArray(value["rules"]) &&
  value["rules"].every(isFormRule)

export const parseClientFormDefinition = (
  value: unknown,
  path = "formDefinition",
): ClientFormDefinition => {
  if (!isClientFormDefinition(value)) {
    throw new Error(`${path} must be a valid client form definition`)
  }

  return value
}

export const parseNullableClientFormDefinition = (
  value: unknown,
  path = "formDefinition",
): ClientFormDefinition | null =>
  value === null ? null : parseClientFormDefinition(value, path)
