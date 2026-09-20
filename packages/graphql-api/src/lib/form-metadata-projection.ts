import {
  type ClientFormDefinition,
  omitClientFormDefinitionFields,
} from "@pf/form-client-representation"

const omitKeys = (
  value: Record<string, unknown>,
  omittedFieldNames: ReadonlySet<string>,
): Record<string, unknown> => {
  if (omittedFieldNames.size === 0) return value

  const visible: Record<string, unknown> = {}
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (!omittedFieldNames.has(fieldName)) {
      visible[fieldName] = fieldValue
    }
  }
  return visible
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface FormMetadataProjection {
  readonly formDefinition: ClientFormDefinition
  readonly defaultValues: Record<string, unknown>
  readonly jsonSchema: Record<string, unknown>
}

export interface OmitFormMetadataFieldsInput {
  readonly definition: ClientFormDefinition
  readonly defaultValues: Record<string, unknown>
  readonly jsonSchema: Record<string, unknown>
  readonly omittedFieldNames: ReadonlySet<string>
}

/** Projects every browser-visible form metadata channel through one field set. */
export const omitFormMetadataFields = ({
  definition,
  defaultValues,
  jsonSchema,
  omittedFieldNames,
}: OmitFormMetadataFieldsInput): FormMetadataProjection => {
  const properties = jsonSchema["properties"]

  return {
    formDefinition: omitClientFormDefinitionFields(
      definition,
      omittedFieldNames,
    ),
    defaultValues: omitKeys(defaultValues, omittedFieldNames),
    jsonSchema: {
      ...jsonSchema,
      ...(isRecord(properties)
        ? { properties: omitKeys(properties, omittedFieldNames) }
        : {}),
      ...(Array.isArray(jsonSchema["required"])
        ? {
            required: jsonSchema["required"].filter(
              (fieldName) =>
                typeof fieldName !== "string" ||
                !omittedFieldNames.has(fieldName),
            ),
          }
        : {}),
    },
  }
}
