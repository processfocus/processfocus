"use client"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Collection } from "@tanstack/db"
import { Schema } from "effect"
import { ClientError } from "graphql-request"
import { Suspense, use, useCallback, useRef } from "react"
import type { FieldError, FormActionsContext } from "@pf/form"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import type { FormRequestData } from "@pf/form-schema"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import { Button } from "@pf/shadcn-components"
import { getNoSchemaStartActionLabels } from "../lib/start-process-actions"
import { ProcessSubmitButton } from "./process-submit-button"
import { findProcessDraft, useProcessDraft } from "@/hooks/use-process-draft"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"
import {
  DraftProcessCollectionProvider,
  useDraftProcessCollection,
} from "@/lib/collections/draft-process-execution-collection-provider"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"
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
  processId: string
  canSkipScheduleWaits: boolean
  startStepPath: string
  mutationName: string
  inputTypeName: string
  pluginConfiguration?: Readonly<Record<string, unknown>>
  defaultValues: Record<string, unknown> | null
  requestData?: FormRequestData | null | undefined
  processName: string
  totalFields: number
  /** Called when form is cancelled or submitted successfully */
  onClose: (result: "cancelled" | "submitted") => void
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
  draftCollection?: Collection<DraftProcessExecutionDocType, string>
  storageKey?: string | undefined
}

function StartProcessFormInner({
  processId,
  canSkipScheduleWaits,
  startStepPath,
  mutationName,
  inputTypeName,
  pluginConfiguration,
  defaultValues,
  requestData,
  processName,
  totalFields,
  onClose,
  draftCollection,
  storageKey,
}: StartProcessFormInnerProps) {
  const graphqlClient = useGraphqlClient()
  const submissionWithoutWaiting = useRef(false)
  const {
    save,
    clear,
    error: draftError,
    isDiscarding,
  } = useProcessDraft({
    collection: draftCollection,
    processId,
    name: processName,
    startStepPath,
    totalFields,
  })

  const handleSubmit = useCallback(
    async (
      values: Record<string, unknown>,
      hasSchemaInput?: boolean,
    ): Promise<FieldError[] | undefined> => {
      const withoutWaiting = submissionWithoutWaiting.current
      submissionWithoutWaiting.current = false
      // Build GraphQL mutation dynamically based on whether we have input
      const hasInput =
        hasSchemaInput ??
        Boolean(inputTypeName && Object.keys(values).length > 0)
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
        await clear()
        onClose("submitted")
        return
      } catch (error) {
        submissionError = error
      }

      // Handle GraphQL errors with validation details
      if (submissionError instanceof ClientError) {
        const gqlError = submissionError.response.errors?.[0]
        if (gqlError?.extensions?.["code"] === "InputValidationError") {
          const validationErrors = gqlError.extensions["errors"] as
            | ValidationError[]
            | undefined
          if (validationErrors && validationErrors.length > 0) {
            // Return field errors to EffectSchemaForm for setting on fields
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
    [graphqlClient, mutationName, inputTypeName, onClose, clear],
  )

  const renderActions = useCallback(
    ({ clearLocalStorage, formState }: FormActionsContext) => (
      <div className="space-y-3">
        <div className="flex justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={isDiscarding || formState.isSubmittingRequest}
            // Blurring a field can move the button before the click fires.
            onPointerDown={(event) => event.preventDefault()}
            onClick={async () => {
              if (!(await clear())) return
              clearLocalStorage()
              onClose("cancelled")
            }}
          >
            {draftCollection
              ? "Discard"
              : getNoSchemaStartActionLabels(totalFields).cancelLabel}
          </Button>
          <ProcessSubmitButton
            canSkipScheduleWaits={canSkipScheduleWaits}
            isSubmitting={formState.isSubmitting || isDiscarding}
          />
        </div>
        {draftError && (
          <p role="alert" className="text-sm text-rose-600">
            {draftError}
          </p>
        )}
      </div>
    ),
    [
      canSkipScheduleWaits,
      clear,
      draftCollection,
      draftError,
      isDiscarding,
      onClose,
      totalFields,
    ],
  )

  const form = inputTypeName ? (
    <BrowserStartForm
      requestData={requestData}
      stepPath={startStepPath}
      pluginConfiguration={pluginConfiguration ?? {}}
      defaultValues={defaultValues ?? {}}
      onSubmit={handleSubmit}
      draftId={storageKey}
      onDraftChange={save}
      renderActions={renderActions}
    />
  ) : (
    <EffectSchemaForm
      schema={emptyStartSchema}
      defaultValues={{}}
      onSubmit={handleSubmit}
    >
      {renderActions}
    </EffectSchemaForm>
  )

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
  return (
    <Suspense fallback={<FormSkeleton />}>
      {props.inputTypeName ? (
        <DraftProcessCollectionProvider>
          <StartProcessWithDraft {...props} />
        </DraftProcessCollectionProvider>
      ) : (
        <StartProcessFormInner {...props} />
      )}
    </Suspense>
  )
}

function StartProcessWithDraft(props: StartProcessFormProps) {
  const { collectionPromise, db, initialSync, retryInitialSync } =
    useDraftProcessCollection()
  const draftCollection = use(collectionPromise)
  if (initialSync.status === "loading") return <FormSkeleton />
  if (initialSync.status === "error") {
    return (
      <div role="alert">
        <p>Couldn't load your last saved values.</p>
        <Button type="button" onClick={retryInitialSync}>
          Retry
        </Button>
      </div>
    )
  }
  const draft = findProcessDraft(draftCollection, props.processId)
  return (
    <StartProcessFormInner
      {...props}
      draftCollection={draftCollection}
      storageKey={
        db ? `process-start-draft-${db.name}/${props.startStepPath}` : undefined
      }
      defaultValues={
        draft?.startStepPath === props.startStepPath
          ? { ...props.defaultValues, ...draft.state }
          : props.defaultValues
      }
    />
  )
}

const emptyStartSchema = Schema.Struct({})

function BrowserStartForm({
  requestData,
  stepPath,
  draftId,
  pluginConfiguration,
  defaultValues,
  onDraftChange,
  onSubmit,
  renderActions,
}: {
  requestData?: FormRequestData | null | undefined
  stepPath: string
  draftId: string | undefined
  pluginConfiguration?: Readonly<Record<string, unknown>>
  defaultValues: Record<string, unknown>
  onDraftChange: NonNullable<
    React.ComponentProps<typeof EffectSchemaForm>["onDraftChange"]
  >
  onSubmit: (
    values: Record<string, unknown>,
    hasInput: boolean,
  ) => Promise<FieldError[] | undefined>
  renderActions: (
    context: FormActionsContext,
    validator: StandardSchemaV1,
  ) => React.ReactNode
}) {
  const schema = use(loadBrowserFormDefinition(stepPath))
  return (
    <EffectSchemaForm
      stepPath={stepPath}
      requestData={requestData}
      schema={schema}
      pluginConfiguration={pluginConfiguration ?? {}}
      draftId={draftId}
      defaultValues={defaultValues}
      onDraftChange={onDraftChange}
      onSubmit={(values) =>
        onSubmit(
          values,
          Object.keys(submissionSchemaSync(schema).fields).length > 0,
        )
      }
    >
      {renderActions}
    </EffectSchemaForm>
  )
}
