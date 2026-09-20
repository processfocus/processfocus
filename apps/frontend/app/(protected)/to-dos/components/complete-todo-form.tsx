"use client"

import { ClientError } from "graphql-request"
import { useCallback, useMemo } from "react"
import {
  type FieldError,
  type FormActionsContext,
  type JsonSchemaRoot,
  dynamicForm,
} from "@pf/form"
import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { Button } from "@pf/shadcn-components"
import { TodoFormActions } from "./todo-form-actions"
import { useGraphqlClient } from "@/lib/graphql/client-provider"

interface CompleteTodoFormProps {
  todoId: string | undefined
  stepPath: string
  inputTypeName: string
  completeMutationName: string
  defaultValues: Record<string, unknown> | null
  formDefinition: ClientFormDefinition | null
  jsonSchema: JsonSchemaRoot | null
  /** Called when form is cancelled or submitted successfully */
  onClose: () => void
}

export function FormSkeleton() {
  return (
    <div className="space-y-4">
      <div className="animate-pulse space-y-4">
        <div className="h-10 rounded bg-slate-200 dark:bg-slate-700" />
        <div className="h-10 rounded bg-slate-200 dark:bg-slate-700" />
        <div className="h-10 rounded bg-slate-200 dark:bg-slate-700" />
      </div>
    </div>
  )
}

export function CompleteTodoForm({
  todoId,
  stepPath,
  inputTypeName,
  completeMutationName,
  defaultValues,
  formDefinition,
  jsonSchema,
  onClose,
}: CompleteTodoFormProps) {
  const graphqlClient = useGraphqlClient()
  const lookupOptions = useMemo(
    () => (todoId ? { todoId } : undefined),
    [todoId],
  )

  // Submit form by calling the generated complete mutation
  const handleSubmit = useCallback(
    async (
      values: Record<string, unknown>,
    ): Promise<FieldError[] | undefined> => {
      if (!todoId) {
        console.error("No todoId provided")
        return
      }

      // Build the GraphQL mutation based on whether there are submittable fields
      // Check jsonSchema properties (not components) since read-only fields
      // appear in components for display but are excluded from submission schema
      const schemaProperties = (
        jsonSchema as { properties?: Record<string, unknown> } | null
      )?.properties
      const hasInput =
        schemaProperties !== undefined &&
        Object.keys(schemaProperties).length > 0
      const mutation = hasInput
        ? `mutation Complete($todoId: ID!, $input: ${inputTypeName}!) {
          ${completeMutationName}(todoId: $todoId, input: $input) {
            executionId
            stepPath
            timestamp
          }
        }`
        : `mutation Complete($todoId: ID!) {
          ${completeMutationName}(todoId: $todoId) {
            executionId
            stepPath
            timestamp
          }
        }`

      try {
        if (hasInput) {
          await graphqlClient.request(mutation, { todoId, input: values })
        } else {
          await graphqlClient.request(mutation, { todoId })
        }
        // Success - close the form
        onClose()
        return
      } catch (error) {
        // Handle GraphQL errors with validation details
        if (error instanceof ClientError) {
          const gqlError = error.response.errors?.[0]
          if (gqlError?.extensions?.["code"] === "InputValidationError") {
            // Extract structured validation errors
            const validationErrors = gqlError.extensions["errors"] as
              | FieldError[]
              | undefined
            if (validationErrors && validationErrors.length > 0) {
              // Return field errors to dynamicForm for setting on fields
              return validationErrors
            }
          }
          // Other GraphQL error - return as form-level error
          const errorMessage =
            gqlError?.message ??
            "An error occurred while submitting the form. Please try again."
          console.error("GraphQL submission error:", errorMessage)
          return [{ field: "", message: errorMessage }]
        } else {
          // Non-GraphQL error - return as form-level error
          const errorMessage =
            error instanceof Error
              ? error.message
              : "An unexpected error occurred. Please try again."
          console.error("Form submission error:", errorMessage)
          return [{ field: "", message: errorMessage }]
        }
      }
    },
    [
      graphqlClient,
      todoId,
      completeMutationName,
      inputTypeName,
      jsonSchema,
      onClose,
    ],
  )

  // Render action buttons
  const renderActions = useCallback(
    (context: FormActionsContext) => {
      // For simple forms (no jsonSchema), render basic buttons
      if (!jsonSchema) {
        return (
          <div className="flex justify-end gap-3">
            <Button type="submit">
              {context.formState.isSubmitting ? "..." : "Done"}
            </Button>
          </div>
        )
      }

      return <TodoFormActions context={context} />
    },
    [jsonSchema],
  )

  // Render the form using dynamicForm
  return dynamicForm({
    draftId: `todo-complete-${todoId ?? stepPath}`,
    formDefinition,
    defaultValues,
    handleCancel: onClose,
    handleSubmit,
    jsonSchema,
    renderActions,
    stepPath,
    lookupOptions,
  })
}
