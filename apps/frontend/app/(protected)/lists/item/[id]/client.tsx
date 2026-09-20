"use client"

import { useQueryClient } from "@tanstack/react-query"
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback } from "react"
import type { JsonSchemaRoot } from "@pf/form"
import { Button } from "@pf/shadcn-components"
import { ListItemEditForm } from "../../components/list-item-edit-form"
import { useListDeletedCallback } from "../../hooks/use-list-deleted-callback"
import { useListItemDetail } from "../../hooks/use-list-item-detail"
import { listDetailTitle } from "../../lib/list-detail-title"
import { markListStale } from "../../lib/list-refresh"
import { formatCellValue } from "../../utils"

interface ListDetailClientProps {
  listPath: string
  itemId: string
}

export default function ListDetailClient({
  listPath,
  itemId,
}: ListDetailClientProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { currentList, itemDetail, formMetadata, isLoading, error } =
    useListItemDetail(listPath, itemId)

  const handleClose = useCallback(() => {
    window.history.back()
  }, [])

  const handleSaved = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["listItem", listPath, itemId],
    })
    markListStale(listPath)
    router.refresh()
  }, [queryClient, listPath, itemId, router])

  const handleDeleted = useListDeletedCallback(listPath, itemId)

  const detailTitle = listDetailTitle(currentList)
  const isAnyLoading = isLoading

  // Loading state
  if (isAnyLoading) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
                Item Details
              </h1>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Loading...
              </p>
            </div>
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // List not found or no item query
  if (!currentList?.itemQueryName) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 shadow-sm dark:border-rose-800 dark:bg-rose-900/20">
            <div className="mb-6 flex items-start gap-4">
              <AlertCircle className="h-8 w-8 text-rose-500" />
              <div>
                <h1 className="text-2xl font-semibold text-rose-900 dark:text-rose-100">
                  List Not Found
                </h1>
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                  {listPath
                    ? `The list "${listPath}" was not found or doesn't support detail view.`
                    : "No list specified."}
                </p>
              </div>
            </div>
            <Link href="/lists">
              <Button variant="outline">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Lists
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 shadow-sm dark:border-rose-800 dark:bg-rose-900/20">
            <div className="mb-6 flex items-start gap-4">
              <AlertCircle className="h-8 w-8 text-rose-500" />
              <div>
                <h1 className="text-2xl font-semibold text-rose-900 dark:text-rose-100">
                  Error Loading Item
                </h1>
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                  {String(error)}
                </p>
              </div>
            </div>
            <Link href={`/lists${listPath}`}>
              <Button variant="outline">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to List
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Item not found
  if (!itemDetail) {
    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 shadow-sm dark:border-amber-800 dark:bg-amber-900/20">
            <div className="mb-6 flex items-start gap-4">
              <AlertCircle className="h-8 w-8 text-amber-500" />
              <div>
                <h1 className="text-2xl font-semibold text-amber-900 dark:text-amber-100">
                  Item Not Found
                </h1>
                <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                  The item with ID &quot;{itemId}&quot; was not found.
                </p>
              </div>
            </div>
            <Link href={`/lists${listPath}`}>
              <Button variant="outline">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to List
              </Button>
            </Link>
          </div>
        </div>
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
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="mb-6">
              <Link
                href={`/lists${listPath}`}
                className="mb-4 inline-flex items-center text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back to {currentList.name}
              </Link>
              <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
                {detailTitle ?? currentList.name}
              </h1>
            </div>
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
          </div>
        </div>
      </div>
    )
  }

  // Fallback: read-only detail view (list doesn't support editing)
  return (
    <div className="flex-1">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-6">
            <Link
              href={`/lists${listPath}`}
              className="mb-4 inline-flex items-center text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to {currentList.name}
            </Link>
            <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
              {detailTitle ?? "Item Details"}
            </h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {currentList.name}
            </p>
          </div>

          <dl className="space-y-4">
            {currentList.outputColumns.map((column) => (
              <div
                key={column.field}
                className="border-b border-slate-100 pb-4 last:border-0 dark:border-slate-800"
              >
                <dt className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {column.label}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-base text-slate-900 dark:text-slate-100">
                  {formatCellValue(itemDetail[column.field]) || (
                    <span className="text-slate-400">&mdash;</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
