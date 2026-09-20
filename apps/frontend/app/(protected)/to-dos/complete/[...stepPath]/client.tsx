"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback } from "react"
import type { JsonSchemaRoot } from "@pf/form"
import { CompleteTodoForm } from "../../components/complete-todo-form"
import { FormSkeleton } from "@/app/(protected)/processes/components/start-process-form"
import { useFormMetadata } from "@/hooks/use-form-metadata"

interface CompleteTodoClientProps {
  todoId: string | undefined
  stepPath: string
  stepName: string
}

export default function CompleteTodoClient({
  todoId,
  stepPath,
  stepName,
}: CompleteTodoClientProps) {
  const router = useRouter()

  // Fetch form metadata via GraphQL, passing todoId for state-based defaults
  const { formMetadata, isLoading, error } = useFormMetadata(stepPath, todoId)

  const defaultValues =
    (formMetadata?.defaultValues as Record<string, unknown> | null) ?? null
  const jsonSchema = (formMetadata?.jsonSchema as JsonSchemaRoot | null) ?? null

  const handleClose = useCallback(() => {
    router.push("/to-dos")
  }, [router])

  const processName = formMetadata?.processName ?? "Loading..."
  const displayStepName = formMetadata?.stepName ?? stepName

  if (isLoading) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="mb-6">
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Link
                  href="/to-dos"
                  prefetch={false}
                  className="hover:text-slate-700 dark:hover:text-slate-200"
                >
                  To-dos
                </Link>
                <span>/</span>
                <span>Loading...</span>
              </div>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-50">
                {stepName}
              </h1>
            </div>
            <FormSkeleton />
          </div>
        </div>
      </div>
    )
  }

  if (error || !formMetadata) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 shadow-sm dark:border-rose-800 dark:bg-rose-900/20">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold text-rose-900 dark:text-rose-100">
                Unable to Load Form
              </h1>
              <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                {error?.message ??
                  "You may not have permission to access this step."}
              </p>
            </div>
            <button
              type="button"
              onClick={handleClose}
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
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Link
                href="/to-dos"
                prefetch={false}
                className="hover:text-slate-700 dark:hover:text-slate-200"
              >
                To-dos
              </Link>
              <span>/</span>
              <span>{processName}</span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-50">
              {displayStepName}
            </h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Complete this step to continue the process.
            </p>
          </div>

          <CompleteTodoForm
            todoId={todoId}
            stepPath={stepPath}
            inputTypeName={formMetadata.inputTypeName}
            completeMutationName={formMetadata.completeMutationName}
            defaultValues={defaultValues}
            formDefinition={formMetadata.formDefinition}
            jsonSchema={jsonSchema}
            onClose={handleClose}
          />
        </div>
      </div>
    </div>
  )
}
