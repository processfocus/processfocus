"use client"

import { useRouter } from "next/navigation"
import { Suspense, useCallback } from "react"
import { Button } from "@pf/shadcn-components"
import {
  CompleteTodoForm,
  FormSkeleton,
} from "../../../components/complete-todo-form"
import { FormDialogContent } from "@/components/form-dialog-content"
import { Dialog } from "@/components/ui/dialog"
import { useFormMetadata } from "@/hooks/use-form-metadata"
import { EffectErrorBoundary } from "@/lib/effect/error-boundary"
import { getDisplayErrorMessage } from "@/lib/errors/get-display-error-message"

interface CompleteTodoModalClientProps {
  todoId: string | undefined
  stepPath: string
  stepName: string
}

// Loading, error and loaded states must agree before async evidence arrives.
const wideDialogClassName = "sm:max-w-[min(90rem,calc(100%-2rem))]"

function CompleteTodoModalClientInner({
  todoId,
  stepPath,
  stepName,
}: CompleteTodoModalClientProps) {
  const router = useRouter()

  // Fetch form metadata via GraphQL, passing todoId for state-based defaults
  const { formMetadata, isLoading, error } = useFormMetadata(stepPath, todoId)

  const defaultValues =
    (formMetadata?.defaultValues as Record<string, unknown> | null) ?? null

  const handleClose = useCallback(() => {
    router.back()
  }, [router])

  const processName = formMetadata?.processName ?? "Loading..."
  const displayStepName = formMetadata?.stepName ?? stepName

  if (isLoading) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
        <FormDialogContent
          className={wideDialogClassName}
          title={stepName}
          description="Loading..."
        >
          <FormSkeleton />
        </FormDialogContent>
      </Dialog>
    )
  }

  if (error || !formMetadata) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
        <FormDialogContent
          className={wideDialogClassName}
          title="Error"
          description="Unable to load form"
        >
          <div className="space-y-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">
              {getDisplayErrorMessage(
                error,
                "You may not have permission to access this step.",
              )}
            </p>
            <Button type="button" variant="outline" onClick={handleClose}>
              Go Back
            </Button>
          </div>
        </FormDialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <FormDialogContent
        className={wideDialogClassName}
        title={displayStepName}
        description={processName}
      >
        <CompleteTodoForm
          todoId={todoId}
          stepPath={stepPath}
          inputTypeName={formMetadata.inputTypeName}
          completeMutationName={formMetadata.completeMutationName}
          defaultValues={defaultValues}
          requestData={formMetadata.requestData}
          pluginConfiguration={formMetadata.pluginConfiguration}
          onClose={handleClose}
        />
      </FormDialogContent>
    </Dialog>
  )
}

function FormErrorFallback({
  error,
  onClose,
}: {
  error: Error
  onClose: () => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-rose-600 dark:text-rose-400">
        Failed to load the form: {error.message}
      </p>
      <Button type="button" variant="outline" onClick={onClose}>
        Go Back
      </Button>
    </div>
  )
}

export default function CompleteTodoModalClient(
  props: CompleteTodoModalClientProps,
) {
  const router = useRouter()

  const handleClose = useCallback(() => {
    router.back()
  }, [router])

  return (
    <EffectErrorBoundary
      fallback={(error) => (
        <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
          <FormDialogContent
            className={wideDialogClassName}
            title="Error"
            description="Unable to load form"
          >
            <FormErrorFallback error={error} onClose={handleClose} />
          </FormDialogContent>
        </Dialog>
      )}
    >
      <Suspense
        fallback={
          <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
            <FormDialogContent
              className={wideDialogClassName}
              title={props.stepName}
              description="Loading..."
            >
              <FormSkeleton />
            </FormDialogContent>
          </Dialog>
        }
      >
        <CompleteTodoModalClientInner {...props} />
      </Suspense>
    </EffectErrorBoundary>
  )
}
