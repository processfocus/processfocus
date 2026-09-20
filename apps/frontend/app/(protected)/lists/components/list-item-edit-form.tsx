"use client"

import { ClientError } from "graphql-request"
import { useCallback, useState } from "react"
import {
  type FieldError,
  type FormActionsContext,
  type JsonSchemaRoot,
  dynamicForm,
} from "@pf/form"
import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import { Button } from "@pf/shadcn-components"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useGraphqlClient } from "@/lib/graphql/client-provider"

interface ListItemEditFormProps {
  itemId: string
  listName: string
  listPath: string
  updateMutationName: string | null
  updateInputTypeName: string | null
  deleteMutationName: string | null
  defaultValues: Record<string, unknown> | null
  formDefinition: ClientFormDefinition | null
  jsonSchema: JsonSchemaRoot | null
  /** Column field names from the list output (for response field selection) */
  outputFields: string[]
  /** Called when form is cancelled or submitted successfully */
  onClose: () => void
  /** Called after a successful save so the caller can refresh data */
  onSaved?: () => void
  /** Called after a successful delete so the caller can refresh data */
  onDeleted?: () => void
}

/**
 * Edit form for a list item, using the same dynamic form system as
 * todo completion and process start forms.
 */
export function ListItemEditForm({
  itemId,
  listName,
  listPath,
  updateMutationName,
  updateInputTypeName,
  deleteMutationName,
  defaultValues,
  formDefinition,
  jsonSchema,
  outputFields,
  onClose,
  onSaved,
  onDeleted,
}: ListItemEditFormProps) {
  const graphqlClient = useGraphqlClient()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (
      values: Record<string, unknown>,
    ): Promise<FieldError[] | undefined> => {
      if (!updateMutationName || !updateInputTypeName) {
        return [{ field: "", message: "This item is read-only." }]
      }

      // Build the GraphQL mutation dynamically
      const fieldsSelection = outputFields.join("\n            ")

      const mutation = `mutation UpdateListItem($id: String!, $input: ${updateInputTypeName}!) {
          ${updateMutationName}(id: $id, input: $input) {
            ${fieldsSelection}
          }
        }`

      let submissionError: unknown
      try {
        await graphqlClient.request(mutation, { id: itemId, input: values })
        if (onSaved !== undefined) {
          onSaved()
        }
        onClose()
        return
      } catch (error) {
        submissionError = error
      }

      if (submissionError instanceof ClientError) {
        const gqlError = submissionError.response.errors?.[0]
        if (gqlError?.extensions?.["code"] === "InputValidationError") {
          const validationErrors = gqlError.extensions["errors"] as
            | FieldError[]
            | undefined
          if (validationErrors && validationErrors.length > 0) {
            return validationErrors
          }
        }
        const errorMessage =
          gqlError?.message ??
          "An error occurred while saving. Please try again."
        console.error("GraphQL submission error:", errorMessage)
        return [{ field: "", message: errorMessage }]
      }
      const errorMessage =
        submissionError instanceof Error
          ? submissionError.message
          : "An unexpected error occurred. Please try again."
      console.error("Form submission error:", errorMessage)
      return [{ field: "", message: errorMessage }]
    },
    [
      graphqlClient,
      itemId,
      updateMutationName,
      updateInputTypeName,
      outputFields,
      onClose,
      onSaved,
    ],
  )

  const handleDelete = useCallback(async () => {
    if (!deleteMutationName) return

    setIsDeleting(true)
    setDeleteError(null)

    const mutation = `mutation DeleteListItem($id: String!) {
        ${deleteMutationName}(id: $id)
      }`

    let deleteFailed = false
    let deleteFailure: unknown
    try {
      await graphqlClient.request(mutation, { id: itemId })
      setShowDeleteDialog(false)
      if (onDeleted !== undefined) {
        onDeleted()
      }
      onClose()
    } catch (error) {
      deleteFailed = true
      deleteFailure = error
    }
    if (deleteFailed) {
      console.error("Delete error:", deleteFailure)
      const message =
        deleteFailure instanceof Error
          ? deleteFailure.message
          : "An error occurred while deleting. Please try again."
      setDeleteError(message)
    }
    setIsDeleting(false)
  }, [deleteMutationName, graphqlClient, itemId, onClose, onDeleted])

  const renderActions = useCallback(
    (context: FormActionsContext) => {
      const { isSubmitting } = context.formState

      return (
        <div className="flex justify-between gap-3">
          <div className="flex gap-3">
            {deleteMutationName && (
              <Button
                type="button"
                variant="outline"
                className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-900/20 dark:hover:text-rose-300"
                onClick={() => setShowDeleteDialog(true)}
                disabled={isSubmitting}
              >
                Delete
              </Button>
            )}
          </div>
          {updateMutationName && updateInputTypeName ? (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "..." : "Save"}
            </Button>
          ) : null}
        </div>
      )
    },
    [deleteMutationName, updateInputTypeName, updateMutationName],
  )

  const form = dynamicForm({
    draftId: `list-item-edit-${listPath}-${itemId}`,
    formDefinition,
    defaultValues,
    handleSubmit,
    jsonSchema,
    renderActions,
    stepPath: listPath,
  })

  return (
    <>
      {form}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>
              <p>
                Delete item {itemId} from {listName}?
              </p>
              <p>This action cannot be undone.</p>
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-600 dark:bg-rose-900/20 dark:text-rose-400">
              {deleteError}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-900/20 dark:hover:text-rose-300"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
