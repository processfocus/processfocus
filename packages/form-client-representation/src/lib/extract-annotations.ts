import type * as AST from "effect/SchemaAST"
import { TitleAnnotationId } from "effect/SchemaAST"
import {
  FormAutoComplete,
  FormDescription,
  FormLabel,
  FormPermission,
  FormReadOnly,
  FormRequired,
  FormStaticText,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
import type { ClientFieldPermissionMetadata } from "./types"

/**
 * Metadata extracted from Effect Schema annotations.
 * Property names match BaseFormComponent for spreading.
 */
export interface FieldMetadata {
  label: string
  description?: string
  autoComplete?: string
  readonly?: boolean // lowercase to match BaseFormComponent
  required?: boolean
  content?: string // for static text fields
  permission?: ClientFieldPermissionMetadata
}

const toFullPath = (path: string): string =>
  // Keep this local: importing normalizePath from @pf/process creates a build
  // cycle because @pf/process depends on @pf/form-client-representation.
  path.startsWith("/") ? path : `/${path}`

const defaultSchemaTitles = new Set([
  "any",
  "bigint",
  "string",
  "number",
  "boolean",
  "null",
  "never",
  "object",
  "symbol",
  "undefined",
  "unknown",
  "void",
])

// Effect Schema adds generated titles for primitives/refinements; these are not
// user-facing labels and should not override the field-name fallback.
const isGeneratedSchemaTitle = (value: string): boolean =>
  defaultSchemaTitles.has(value) || /^[a-z]+\(.*\)$/i.test(value)

const humanizeFieldName = (fieldName: string): string => {
  const spaced = fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()

  if (spaced.length === 0) return fieldName

  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1).toLowerCase()}`
}

/**
 * Extract FormLabel, FormDescription, and FormReadOnly annotations from AST.
 * Note: FormDefault is handled separately at runtime when process state is available.
 */
export const extractAnnotations = (
  annotations: AST.Annotations,
  fieldName: string,
): FieldMetadata => {
  const labelValue = annotations[FormLabel]
  const titleValue = annotations[TitleAnnotationId]
  const title =
    typeof titleValue === "string" && !isGeneratedSchemaTitle(titleValue)
      ? titleValue
      : undefined
  const label =
    typeof labelValue === "string" && labelValue.length > 0
      ? labelValue
      : (title ?? humanizeFieldName(fieldName))

  const result: FieldMetadata = { label }

  const descValue = annotations[FormDescription]
  if (typeof descValue === "string") {
    result.description = descValue
  }

  const autoCompleteValue = annotations[FormAutoComplete]
  if (typeof autoCompleteValue === "string") {
    result.autoComplete = autoCompleteValue
  }

  const readOnlyValue = annotations[FormReadOnly]
  if (typeof readOnlyValue === "boolean") {
    result.readonly = readOnlyValue // lowercase to match BaseFormComponent
  }

  const permissionValue = annotations[FormPermission]
  if (isFieldPermissionMetadata(permissionValue)) {
    result.permission = {
      modify: toFullPath(permissionValue.modify.node.path),
    }
  }

  const requiredValue = annotations[FormRequired]
  if (typeof requiredValue === "boolean") {
    result.required = requiredValue
  }

  const staticTextValue = annotations[FormStaticText]
  if (typeof staticTextValue === "string") {
    result.content = staticTextValue
  }

  return result
}
