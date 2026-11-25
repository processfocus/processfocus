"use client"

import { Suspense, use, useCallback, useEffect } from "react"
import type { FieldError, FormActionsContext } from "@pf/form"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useFormMetadata } from "@/hooks/use-form-metadata"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"
import type { WorkflowStepData } from "@/lib/workflow/types"

interface WorkflowFormPreviewSheetProps {
  step: WorkflowStepData
  open: boolean
  onOpenChange: (open: boolean) => void
}

function FormPreviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-10 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-10 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
    </div>
  )
}

export function WorkflowFormPreviewSheet({
  step,
  open,
  onOpenChange,
}: WorkflowFormPreviewSheetProps) {
  const draftId = `workflow-form-preview-${step.id}`
  const { formMetadata, isLoading, error } = useFormMetadata(step.path)

  useEffect(() => {
    return () => {
      window.localStorage.removeItem(draftId)
    }
  }, [draftId])

  const handleSubmit = useCallback(async (): Promise<FieldError[]> => {
    return [
      {
        field: "",
        message: "This form preview cannot be submitted from the workflow.",
      },
    ]
  }, [])

  const renderActions = useCallback((_context: FormActionsContext) => null, [])

  const defaultValues =
    (formMetadata?.defaultValues as Record<string, unknown> | null) ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 overflow-hidden !border-slate-200 !bg-white p-0 shadow-2xl ring-1 ring-slate-950/5 sm:max-w-xl md:max-w-2xl dark:!border-slate-500 dark:!bg-slate-950 dark:ring-slate-600/40 dark:shadow-[-24px_0_48px_rgba(0,0,0,0.7)]"
        data-testid="workflow-form-preview-sheet"
      >
        <SheetHeader className="shrink-0 border-b border-slate-200 px-6 py-5 pr-14 dark:border-slate-800">
          <SheetTitle>{formMetadata?.stepName ?? step.name}</SheetTitle>
          <SheetDescription>{step.purpose}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? <FormPreviewSkeleton /> : null}
          {!isLoading && (error || !formMetadata) ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
              Unable to load this form.
            </div>
          ) : null}
          {!isLoading && formMetadata ? (
            <Suspense fallback={<FormPreviewSkeleton />}>
              <ExecutablePreview
                stepPath={step.path}
                draftId={draftId}
                defaultValues={defaultValues ?? {}}
                requestData={formMetadata.requestData}
                onSubmit={handleSubmit}
              >
                {renderActions}
              </ExecutablePreview>
            </Suspense>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ExecutablePreview(
  props: Omit<React.ComponentProps<typeof EffectSchemaForm>, "schema"> & {
    stepPath: string
  },
) {
  const schema = use(loadBrowserFormDefinition(props.stepPath))
  return <EffectSchemaForm {...props} schema={schema} />
}
