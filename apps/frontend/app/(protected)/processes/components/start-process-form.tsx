"use client"

import type { Collection } from "@tanstack/db"
import { ClientError } from "graphql-request"
import { Suspense, use, useCallback, useRef } from "react"
import {
  type FieldError,
  type FormActionsContext,
  type JsonSchemaRoot,
  dynamicForm,
} from "@pf/form"
import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { getNoSchemaStartActionLabels } from "../lib/start-process-actions"
import { ProcessFormActions } from "./process-form-actions"
import { ProcessSubmitButton } from "./process-submit-button"
import { useProcessesQuery } from "@/hooks/use-processes-query"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"
import { useDraftProcessCollection } from "@/lib/collections/draft-process-execution-collection-provider"
import { useGraphqlClient } from "@/lib/graphql/client-provider"

/**
 * Validation error from GraphQL error extensions
 */
interface ValidationError {
  field: string
  message: string
}

/**
 * Response from start process mutation
 */
interface StartProcessResponse {
  executionId: string
  processId: string
  processPath: string
  timestamp: string
}

interface StartProcessFormProps {
  startStepPath: string
  mutationName: string
  inputTypeName: string
  defaultValues: Record<string, unknown> | null
  formDefinition: ClientFormDefinition | null
  jsonSchema: JsonSchemaRoot | null
  processName: string
  totalFields: number
  /** Optional draft ID to continue from saved state */
  draftId: string | undefined
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

interface StartProcessFormInnerProps extends StartProcessFormProps {
  collectionPromise: Promise<Collection<DraftProcessExecutionDocType, string>>
}

function StartProcessFormInner({
  startStepPath,
  mutationName,
  inputTypeName,
  defaultValues,
  formDefinition,
  jsonSchema,
  processName,
  totalFields,
  draftId,
  onClose,
  collectionPromise,
}: StartProcessFormInnerProps) {
  const graphqlClient = useGraphqlClient()
  const submissionWithoutWaiting = useRef(false)

  // Suspend until collection is ready
  const draftProcessExecutionCollection = use(collectionPromise)

  // Look up the database process ID by start step path
  const { processes } = useProcessesQuery()
  const process = processes.find((p) => p.startStepPath === startStepPath)
  const processId = process?.id ?? ""

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  // Check if we're continuing from an existing draft (draftId starts with "pst-")
  const isExistingDraft = draftId?.startsWith("pst-") ?? false
  const effectiveDraftId = draftId ?? `process-start-draft-${startStepPath}`

  const handleSubmit = useCallback(
    async (
      values: Record<string, unknown>,
    ): Promise<FieldError[] | undefined> => {
      const withoutWaiting = submissionWithoutWaiting.current
      submissionWithoutWaiting.current = false
      // Build GraphQL mutation dynamically based on whether we have input
      const hasInput = inputTypeName && Object.keys(values).length > 0
      const mutation = hasInput
        ? `
          mutation StartProcess($input: ${inputTypeName}!, $withoutWaiting: Boolean!) {
            ${mutationName}(input: $input, withoutWaiting: $withoutWaiting) {
              executionId
              processId
              processPath
              timestamp
            }
          }
        `
        : `
          mutation StartProcess($withoutWaiting: Boolean!) {
            ${mutationName}(withoutWaiting: $withoutWaiting) {
              executionId
              processId
              processPath
              timestamp
            }
          }
        `
      const variables = hasInput
        ? { input: values, withoutWaiting }
        : { withoutWaiting }

      let submissionError: unknown
      try {
        await graphqlClient.request<Record<string, StartProcessResponse>>(
          mutation,
          variables,
        )
        // Success - delete draft from RxDB if exists
        if (isExistingDraft) {
          if (draftId) {
            if (draftProcessExecutionCollection.has(draftId)) {
              draftProcessExecutionCollection.delete(draftId)
            }
          }
        }
        // Close the form
        onClose()
        return
      } catch (error) {
        submissionError = error
      }

      // Handle GraphQL errors with validation details
      if (submissionError instanceof ClientError) {
        const gqlError = submissionError.response.errors?.[0]
        if (gqlError?.extensions?.["code"] === "InputValidationError") {
          // Extract structured validation errors
          const validationErrors = gqlError.extensions["errors"] as
            | ValidationError[]
            | undefined
          if (validationErrors && validationErrors.length > 0) {
            // Return field errors to dynamicForm for setting on fields
            return validationErrors
          }
        }
        // Other GraphQL error - return as form-level error
        const errorMessage =
          gqlError?.message ??
          "An error occurred while starting the process. Please try again."
        console.error("GraphQL submission error:", errorMessage)
        return [{ field: "", message: errorMessage }]
      }
      // Non-GraphQL error - return as form-level error
      const errorMessage =
        submissionError instanceof Error
          ? submissionError.message
          : "An unexpected error occurred. Please try again."
      console.error("Form submission error:", errorMessage)
      return [{ field: "", message: errorMessage }]
    },
    [
      graphqlClient,
      mutationName,
      inputTypeName,
      onClose,
      isExistingDraft,
      draftId,
      draftProcessExecutionCollection,
    ],
  )

  // Render action buttons with draft persistence logic
  const renderActions = useCallback(
    (context: FormActionsContext) => {
      // For simple forms (no jsonSchema), render basic buttons
      if (!jsonSchema) {
        const labels = getNoSchemaStartActionLabels(totalFields)

        return (
          <div className="flex justify-between gap-3">
            <button
              type="button"
              className="rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 shadow hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              onClick={handleCancel}
            >
              {labels.cancelLabel}
            </button>
            <ProcessSubmitButton
              canSkipScheduleWaits={process?.canSkipScheduleWaits ?? false}
              isSubmitting={context.formState.isSubmitting}
            />
          </div>
        )
      }

      return (
        <ProcessFormActions
          context={context}
          canSkipScheduleWaits={process?.canSkipScheduleWaits ?? false}
          draftCollection={draftProcessExecutionCollection}
          draftId={effectiveDraftId}
          processId={processId}
          name={processName}
          startStepPath={startStepPath}
          totalFields={totalFields}
          jsonSchema={jsonSchema}
          onDiscard={handleCancel}
        />
      )
    },
    [
      jsonSchema,
      process?.canSkipScheduleWaits,
      draftProcessExecutionCollection,
      effectiveDraftId,
      processId,
      processName,
      startStepPath,
      totalFields,
      handleCancel,
    ],
  )

  const form = dynamicForm({
    draftId: effectiveDraftId,
    formDefinition,
    defaultValues,
    handleCancel,
    handleSubmit,
    jsonSchema,
    renderActions,
    stepPath: startStepPath,
  })

  return (
    <div
      onSubmitCapture={(event) => {
        const nativeEvent = event.nativeEvent
        const submitter =
          "submitter" in nativeEvent ? nativeEvent.submitter : null
        submissionWithoutWaiting.current =
          submitter instanceof HTMLElement &&
          submitter.dataset["withoutWaiting"] === "true"
      }}
    >
      {form}
    </div>
  )
}

export function StartProcessForm(props: StartProcessFormProps) {
  const { collectionPromise } = useDraftProcessCollection()

  return (
    <Suspense fallback={<FormSkeleton />}>
      <StartProcessFormInner {...props} collectionPromise={collectionPromise} />
    </Suspense>
  )
}
