import type { JsonSchemaRoot } from "@pf/form"
import {
  type ClientFormDefinition,
  parseNullableClientFormDefinition,
} from "@pf/form-client-representation/client-form-definition"
import {
  type FormComponent,
  FormComponentType,
} from "@pf/form-client-representation/types"

export type PublicTodoStatus =
  | "ACTIVE"
  | "COMPLETED"
  | "EXPIRED"
  | "UNAVAILABLE"

type PublicTodoFormDefinitionState =
  | {
      readonly formDefinitionStatus: "parsed"
      readonly formDefinition: ClientFormDefinition | null
    }
  | {
      readonly formDefinitionStatus: "malformed"
      readonly formDefinition: null
    }

interface PublicTodoFormMetadataFields {
  readonly stepPath: string
  readonly processName: string
  readonly publicFormTitle?: string | null
  readonly publicFormDescription?: string | null
  readonly defaultValues: unknown
  readonly jsonSchema: unknown
}

export type PublicTodoFormMetadata = PublicTodoFormMetadataFields &
  PublicTodoFormDefinitionState

export interface PublicTodoResult {
  readonly todoId: string
  readonly status: PublicTodoStatus
  readonly organisationName?: string | null
  readonly completionMessage?: string | null
  readonly formMetadata: PublicTodoFormMetadata | null
}

export interface PublicTodoCompletionResult {
  readonly todoId: string
  readonly status: PublicTodoStatus
  readonly completionMessage?: string | null
}

export const parsePublicTodoFormDefinition = (
  value: unknown,
): PublicTodoFormDefinitionState => {
  try {
    return {
      formDefinitionStatus: "parsed",
      formDefinition: parseNullableClientFormDefinition(
        value,
        "publicTodo.formMetadata.formDefinition",
      ),
    }
  } catch {
    return {
      formDefinitionStatus: "malformed",
      formDefinition: null,
    }
  }
}

export const publicTodoTerminalStatusFromResult = (
  todo: Pick<PublicTodoResult, "status"> | null | undefined,
): Exclude<PublicTodoStatus, "ACTIVE"> =>
  todo?.status && todo.status !== "ACTIVE" ? todo.status : "COMPLETED"

export const publicTodoStateCopy = (
  status: Exclude<PublicTodoStatus, "ACTIVE">,
) => {
  switch (status) {
    case "COMPLETED":
      return {
        title: "This form has already been submitted",
        description: "Contact the sender if you need to make changes.",
      }
    case "EXPIRED":
      return {
        title: "This link has expired",
        description:
          "Ask the sender for a new link if you still need to complete this form.",
      }
    case "UNAVAILABLE":
      return {
        title: "Invalid link",
        description: "This link is invalid. Contact the sender for help.",
      }
  }
}

const embeddedSafeComponentTypes = new Set<string>([
  FormComponentType.Text,
  FormComponentType.TextArea,
  FormComponentType.Number,
  FormComponentType.Email,
  FormComponentType.Phone,
  FormComponentType.Boolean,
  FormComponentType.FieldSet,
  FormComponentType.List,
  FormComponentType.Lookup,
  FormComponentType.CalendarSlot,
  FormComponentType.Static,
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const dependentLookupUnsupportedType = "dependent-lookup"

const collectUnsupportedTypes = (
  component: FormComponent,
  unsupported: Set<string>,
) => {
  const tag = component["_tag"]
  if (!embeddedSafeComponentTypes.has(tag)) {
    unsupported.add(tag)
  }

  if (
    tag === FormComponentType.Lookup &&
    ((Array.isArray(component["dependencies"]) &&
      component["dependencies"].length > 0) ||
      typeof component["queryName"] === "string")
  ) {
    unsupported.add(dependentLookupUnsupportedType)
  }

  if (tag === FormComponentType.FieldSet) {
    for (const child of Object.values(component.children)) {
      collectUnsupportedTypes(child, unsupported)
    }
  }

  if (tag === FormComponentType.List) {
    for (const child of Object.values(component.itemChildren)) {
      collectUnsupportedTypes(child, unsupported)
    }
  }
}

export const publicTodoUnsupportedComponentTypes = (
  formDefinition: ClientFormDefinition | null,
): string[] => {
  if (formDefinition === null) {
    return []
  }

  const unsupported = new Set<string>()
  for (const component of Object.values(formDefinition.components)) {
    collectUnsupportedTypes(component, unsupported)
  }

  return [...unsupported].sort()
}

export const publicTodoUnsupportedMetadataTypes = (
  formMetadata: PublicTodoFormMetadata,
): string[] => {
  if (formMetadata.formDefinitionStatus === "malformed") {
    return ["unknown"]
  }

  return publicTodoUnsupportedComponentTypes(formMetadata.formDefinition)
}

export const publicTodoDefaultValues = (
  defaultValues: unknown,
): Record<string, unknown> | null =>
  isRecord(defaultValues) ? defaultValues : null

export const publicTodoJsonSchema = (
  jsonSchema: unknown,
): JsonSchemaRoot | null => {
  if (!isRecord(jsonSchema)) {
    return null
  }

  const type = jsonSchema["type"]
  if (
    typeof type !== "string" &&
    !Array.isArray(type) &&
    !isRecord(jsonSchema["properties"]) &&
    !Array.isArray(jsonSchema["anyOf"]) &&
    !Array.isArray(jsonSchema["oneOf"]) &&
    !Array.isArray(jsonSchema["allOf"])
  ) {
    return null
  }

  return jsonSchema as JsonSchemaRoot
}
