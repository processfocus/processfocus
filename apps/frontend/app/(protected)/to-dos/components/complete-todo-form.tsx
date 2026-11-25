"use client"

import { ClientError } from "graphql-request"
import { Suspense, use, useCallback, useMemo } from "react"
import type { FieldError, FormActionsContext } from "@pf/form"
import {
  type BrowserFormSchema,
  EffectSchemaForm,
} from "@pf/form/effect-schema-form"
import type { FormRequestData } from "@pf/form-schema"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import { TodoFormActions } from "./todo-form-actions"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"
import { useGraphqlClient } from "@/lib/graphql/client-provider"

interface CompleteTodoFormProps {
  pluginConfiguration?: Readonly<Record<string, unknown>>

  requestData?: FormRequestData | null | undefined
  todoId: string | undefined
  stepPath: string
  inputTypeName: string
  completeMutationName: string
  defaultValues: Record<string, unknown> | null
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

function CompleteTodoFormInner({
  schema,
  requestData,
  pluginConfiguration = {},
  todoId,
  stepPath,
  inputTypeName,
  completeMutationName,
  defaultValues,
  onClose,
}: CompleteTodoFormProps & { schema: BrowserFormSchema }) {
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

      const hasInput =
        Object.keys(submissionSchemaSync(schema).fields).length > 0
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
        onClose()
        return
      } catch (error) {
        // Handle GraphQL errors with validation details
        if (error instanceof ClientError) {
          const gqlError = error.response.errors?.[0]
          if (gqlError?.extensions?.["code"] === "InputValidationError") {
            const validationErrors = gqlError.extensions["errors"] as
              | FieldError[]
              | undefined
            if (validationErrors && validationErrors.length > 0) {
              // Return field errors to EffectSchemaForm for setting on fields
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
      schema,
      onClose,
    ],
  )

  const renderActions = useCallback((context: FormActionsContext) => {
    return <TodoFormActions context={context} />
  }, [])

  return (
    <EffectSchemaForm
      stepPath={stepPath}
      lookupOptions={lookupOptions}
      schema={schema}
      requestData={requestData}
      pluginConfiguration={pluginConfiguration}
      draftId={`todo-complete-${todoId ?? stepPath}`}
      defaultValues={defaultValues ?? {}}
      onSubmit={handleSubmit}
    >
      {renderActions}
    </EffectSchemaForm>
  )
}

function BrowserTodoForm(props: CompleteTodoFormProps) {
  const schema = use(loadBrowserFormDefinition(props.stepPath))
  return <CompleteTodoFormInner {...props} schema={schema} />
}

export function CompleteTodoForm(props: CompleteTodoFormProps) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <BrowserTodoForm {...props} />
    </Suspense>
  )
}
