"use client"

import { useRouter } from "next/navigation"
import { Suspense, useCallback } from "react"
import {
  FormSkeleton,
  StartProcessForm,
} from "../../../components/start-process-form"
import { useReturnToList } from "@/app/(protected)/lists/lib/list-refresh-provider"
import { FormDialogContent } from "@/components/form-dialog-content"
import { Dialog } from "@/components/ui/dialog"
import { useFormMetadata } from "@/hooks/use-form-metadata"
import { getDisplayErrorMessage } from "@/lib/errors/get-display-error-message"

interface StartProcessModalClientProps {
  startStepPath: string
  description?: string
  onClose?: (result: "cancelled" | "submitted") => void
  onCloseAutoFocus?: (event: Event) => void
}

function StartProcessModalClientInner({
  startStepPath,
  description = "Start a process",
  onClose,
  onCloseAutoFocus,
}: StartProcessModalClientProps) {
  const router = useRouter()
  const returnToList = useReturnToList()

  // Fetch form metadata via GraphQL
  const {
    formMetadata,
    isLoading: isMetadataLoading,
    error: metadataError,
  } = useFormMetadata(startStepPath)

  const defaultValues =
    (formMetadata?.defaultValues as Record<string, unknown> | null) ?? null

  const handleClose = (result: "cancelled" | "submitted" = "cancelled") => {
    if (onClose) return onClose(result)
    if (!returnToList(result)) router.back()
  }

  const processName = formMetadata?.processName ?? "Loading..."

  const renderContent = () => {
    if (isMetadataLoading) {
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
            onClick={() => handleClose()}
            className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-500"
          >
            Go Back
          </button>
        </div>
      )
    }

    return (
      <StartProcessForm
        processId={formMetadata.processId ?? ""}
        canSkipScheduleWaits={formMetadata.canSkipScheduleWaits ?? false}
        startStepPath={startStepPath}
        mutationName={formMetadata.mutationName}
        inputTypeName={formMetadata.inputTypeName}
        defaultValues={defaultValues}
        requestData={formMetadata.requestData}
        pluginConfiguration={formMetadata.pluginConfiguration ?? {}}
        processName={formMetadata.processName}
        totalFields={formMetadata.totalFields}
        onClose={handleClose}
      />
    )
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <FormDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        title={metadataError ? "Error" : processName}
        description={metadataError ? "An error occurred" : description}
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
    if (props.onClose) props.onClose("cancelled")
    else router.back()
  }, [router, props.onClose])

  return (
    <Suspense
      fallback={
        <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
          <FormDialogContent
            onCloseAutoFocus={props.onCloseAutoFocus}
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
