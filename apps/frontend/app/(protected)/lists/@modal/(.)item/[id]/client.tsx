"use client"

import { useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Suspense, useCallback } from "react"
import type { JsonSchemaRoot } from "@pf/form"
import { ListItemEditForm } from "../../../components/list-item-edit-form"
import { useListDeletedCallback } from "../../../hooks/use-list-deleted-callback"
import { useListItemDetail } from "../../../hooks/use-list-item-detail"
import { listDetailTitle } from "../../../lib/list-detail-title"
import { markListStale } from "../../../lib/list-refresh"
import { formatCellValue } from "../../../utils"
import { FormDialogContent } from "@/components/form-dialog-content"
import { Dialog } from "@/components/ui/dialog"
import { getDisplayErrorMessage } from "@/lib/errors/get-display-error-message"

interface ListDetailModalClientProps {
  listPath: string
  itemId: string
}

function ListDetailModalClientInner({
  listPath,
  itemId,
}: ListDetailModalClientProps) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const handleClose = useCallback(() => {
    router.back()
  }, [router])

  const { currentList, itemDetail, formMetadata, isLoading, error } =
    useListItemDetail(listPath, itemId)

  const handleSaved = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["listItem", listPath, itemId],
    })
    markListStale(listPath)
    router.refresh()
  }, [queryClient, listPath, itemId, router])

  const handleDeleted = useListDeletedCallback(listPath, itemId)

  const listName = currentList?.name ?? "Loading..."
  const detailTitle = listDetailTitle(currentList) ?? listName
  const isAnyLoading = isLoading

  const renderContent = () => {
    if (isAnyLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )
    }

    if (error) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {getDisplayErrorMessage(error, "Unable to load this item.")}
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

    if (!currentList?.itemQueryName) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {listPath
              ? "List not found or doesn't support detail view."
              : "No list specified."}
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

    if (!itemDetail) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Item not found.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full bg-slate-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-500"
          >
            Go Back
          </button>
        </div>
      )
    }

    // Editable form (primary path when list supports editing)
    if (formMetadata) {
      const schemaDefaults =
        (formMetadata.defaultValues as Record<string, unknown> | null) ?? null
      // Merge schema defaults with actual item data (item data takes precedence).
      // Null values from itemDetail fall back to schema defaults to avoid
      // React warnings about null value props on controlled inputs.
      const defaultValues = schemaDefaults
        ? Object.fromEntries(
            Object.entries({ ...schemaDefaults, ...itemDetail }).map(
              ([key, value]) => [
                key,
                value !== null ? value : (schemaDefaults[key] ?? ""),
              ],
            ),
          )
        : (itemDetail as Record<string, unknown> | null)
      const jsonSchema =
        (formMetadata.jsonSchema as JsonSchemaRoot | null) ?? null

      return (
        <ListItemEditForm
          itemId={itemId}
          listName={currentList.name}
          listPath={listPath}
          updateMutationName={formMetadata.updateMutationName ?? null}
          updateInputTypeName={formMetadata.updateInputTypeName ?? null}
          deleteMutationName={formMetadata.deleteMutationName ?? null}
          defaultValues={defaultValues}
          formDefinition={formMetadata.formDefinition}
          jsonSchema={jsonSchema}
          outputFields={currentList.outputColumns.map((c) => c.field)}
          onClose={handleClose}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )
    }

    // Fallback: read-only detail view (list doesn't support editing)
    return (
      <dl className="space-y-4">
        {currentList.outputColumns.map((column) => (
          <div
            key={column.field}
            className="border-b border-slate-100 pb-3 last:border-0 dark:border-slate-800"
          >
            <dt className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {column.label}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-900 dark:text-slate-100">
              {formatCellValue(itemDetail[column.field]) || (
                <span className="text-slate-400">&mdash;</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <FormDialogContent
        className="sm:max-w-4xl"
        title={error || !currentList ? "Error" : detailTitle}
        description={error || !currentList ? "Something went wrong" : undefined}
      >
        {renderContent()}
      </FormDialogContent>
    </Dialog>
  )
}

export default function ListDetailModalClient(
  props: ListDetailModalClientProps,
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
            className="sm:max-w-4xl"
            title="Loading..."
            description="Loading..."
          >
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          </FormDialogContent>
        </Dialog>
      }
    >
      <ListDetailModalClientInner {...props} />
    </Suspense>
  )
}
