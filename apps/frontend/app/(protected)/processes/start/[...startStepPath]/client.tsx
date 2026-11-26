"use client"

import { useRouter } from "next/navigation"
import { Suspense } from "react"
import {
  FormSkeleton,
  StartProcessForm,
} from "../../components/start-process-form"
import { useReturnToList } from "@/app/(protected)/lists/lib/list-refresh-provider"
import { useFormMetadata } from "@/hooks/use-form-metadata"

interface StartProcessClientProps {
  startStepPath: string
}

function StartProcessClientInner({ startStepPath }: StartProcessClientProps) {
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
    if (returnToList(result)) return
    router.push("/processes")
  }

  if (isMetadataLoading) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
                Loading...
              </h1>
            </div>
            <FormSkeleton />
          </div>
        </div>
      </div>
    )
  }

  // Show error state if metadata loading failed (likely permission denied or not found)
  if (metadataError || !formMetadata) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 shadow-sm dark:border-rose-800 dark:bg-rose-900/20">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold text-rose-900 dark:text-rose-100">
                Unable to Load Form
              </h1>
            </div>
            <p className="mb-4 text-sm text-rose-600 dark:text-rose-400">
              {metadataError?.message ??
                "You may not have permission to access this process."}
            </p>
            <button
              type="button"
              onClick={() => handleClose()}
              className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-500"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-6">
            <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
              {formMetadata.processName}
            </h1>
          </div>
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
        </div>
      </div>
    </div>
  )
}

export default function StartProcessClient(props: StartProcessClientProps) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <StartProcessClientInner {...props} />
    </Suspense>
  )
}
