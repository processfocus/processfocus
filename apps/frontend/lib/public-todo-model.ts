import type { BrowserFormSchema } from "@pf/form/effect-schema-form"
import {
  FormComponentPluginType,
  FormFileInput,
  FormListInput,
  FormProviderUserInput,
  type FormRequestData,
  FormTableInput,
  fieldAnnotation,
} from "@pf/form-schema"
import { executableFields } from "@pf/form-submission-schema"

export type PublicTodoStatus =
  | "ACTIVE"
  | "COMPLETED"
  | "EXPIRED"
  | "UNAVAILABLE"

export interface PublicTodoFormMetadata {
  readonly stepPath: string
  readonly processName: string
  readonly publicFormTitle?: string | null
  readonly publicFormDescription?: string | null
  readonly defaultValues: Record<string, unknown> | null
  readonly requestData: FormRequestData
}

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

/** Backend-connected capabilities require token-scoped APIs, not Dashboard services. */
export const publicTodoUnsupportedFields = (
  schema: BrowserFormSchema,
  requestData: FormRequestData,
): string[] => {
  const unsupported = new Set<string>()
  for (const field of executableFields(schema, {}, requestData.inaccessible)) {
    if (
      requestData.inaccessible.some(
        (path) =>
          field.path.join(".") === path ||
          field.path.join(".").startsWith(`${path}.`),
      )
    )
      continue
    for (const [annotation, name] of [
      [FormFileInput, "file"],
      [FormProviderUserInput, "provider-user"],
      [FormComponentPluginType, "plugin"],
      [FormListInput, "list"],
      [FormTableInput, "table"],
    ] as const) {
      if (fieldAnnotation(field.schema.ast, annotation) !== undefined)
        unsupported.add(name)
    }
  }
  if (Object.keys(requestData.lookups ?? {}).length > 0)
    unsupported.add("dependent-lookup")
  if (requestData.prefill) unsupported.add("prefill")
  return [...unsupported].sort()
}
