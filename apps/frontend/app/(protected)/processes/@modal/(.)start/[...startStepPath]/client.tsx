"use client"

import { useRouter } from "next/navigation"
import { Suspense, useCallback } from "react"
import type { JsonSchemaRoot } from "@pf/form"
import {
  FormSkeleton,
  StartProcessForm,
} from "../../../components/start-process-form"
import { FormDialogContent } from "@/components/form-dialog-content"
import { Dialog } from "@/components/ui/dialog"
import { useDraftState } from "@/hooks/use-draft-state"
import { useFormMetadata } from "@/hooks/use-form-metadata"
import { getDisplayErrorMessage } from "@/lib/errors/get-display-error-message"

interface StartProcessModalClientProps {
  startStepPath: string
  draftId: string | undefined
}

function StartProcessModalClientInner({
  startStepPath,
  draftId,
}: StartProcessModalClientProps) {
  const router = useRouter()

  // Fetch form metadata via GraphQL
  const {
    formMetadata,
    isLoading: isMetadataLoading,
    error: metadataError,
  } = useFormMetadata(startStepPath)

  const defaultValues =
    (formMetadata?.defaultValues as Record<string, unknown> | null) ?? null
  const jsonSchema = (formMetadata?.jsonSchema as JsonSchemaRoot | null) ?? null

  // Load draft state from RxDB and merge with default values
  const {
    mergedDefaultValues,
    isLoading: isDraftLoading,
    isError: isDraftError,
  } = useDraftState(draftId, defaultValues)

  const handleClose = useCallback(() => {
    router.back()
  }, [router])

  const isLoading = isMetadataLoading || isDraftLoading
  const processName = formMetadata?.processName ?? "Loading..."

  const renderContent = () => {
    if (isLoading) {
      return <FormSkeleton />
    }

    if (metadataError || !formMetadata) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {getDisplayErrorMessage(
              metadataError,
              "You may not have permission to access this process.",
            )}
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-500"
          >
            Go Back
          </button>
        </div>
      )
    }

    if (isDraftError) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-rose-600 dark:text-rose-400">
            Failed to load the saved draft. Please try again or start a new
            process.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-500"
          >
            Go Back
          </button>
        </div>
      )
    }

    return (
      <StartProcessForm
        startStepPath={startStepPath}
        mutationName={formMetadata.mutationName}
        inputTypeName={formMetadata.inputTypeName}
        defaultValues={mergedDefaultValues}
        formDefinition={formMetadata.formDefinition}
        jsonSchema={jsonSchema}
        processName={formMetadata.processName}
        totalFields={formMetadata.totalFields}
        draftId={draftId}
        onClose={handleClose}
      />
    )
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <FormDialogContent
        title={metadataError || isDraftError ? "Error" : processName}
        description={
          metadataError || isDraftError
            ? "An error occurred"
            : "Start a new process"
        }
      >
        {renderContent()}
      </FormDialogContent>
    </Dialog>
  )
}

export default function StartProcessModalClient(
  props: StartProcessModalClientProps,
) {
  const router = useRouter()

  const handleClose = useCallback(() => {
    router.back()
  }, [router])

  return (
    <Suspense
      fallback={
        <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
          <FormDialogContent
            title="Loading..."
            description="Loading process form"
          >
            <FormSkeleton />
          </FormDialogContent>
        </Dialog>
      }
    >
      <StartProcessModalClientInner {...props} />
    </Suspense>
  )
}
