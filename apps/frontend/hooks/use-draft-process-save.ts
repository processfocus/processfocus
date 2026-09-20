"use client"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Collection } from "@tanstack/db"
import { useCallback, useEffect, useMemo, useState } from "react"
import { ulid } from "ulidx"
import {
  type JsonSchemaRoot,
  createStandardSchemaFromJsonSchema,
} from "@pf/form"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"

const createDraftId = (draftId: string): string =>
  draftId.startsWith("pst-") ? draftId : `pst-${ulid()}`

interface UseDraftProcessSaveOptions {
  draftId: string
  draftCollection: Collection<DraftProcessExecutionDocType, string>
  processId: string
  name: string
  startStepPath: string
  totalFields: number
  jsonSchema: JsonSchemaRoot
  /** Called after draft is cleared (from localStorage clear callback) */
  clearLocalStorage: () => void
  /** Called after successful discard to navigate away */
  onDiscard: () => void
}

interface UseDraftProcessSaveResult {
  /** Save form values as a draft to RxDB */
  handleSaveDraft: (values: Record<string, unknown>) => Promise<void>
  /** Discard the draft (clear localStorage + delete from RxDB) */
  handleDiscard: () => void
  /** Calculate how many fields are valid for progress tracking */
  calculateFieldsCompleted: (values: Record<string, unknown>) => number
  /** Error message if draft save failed */
  draftSaveError: string | null
  /** Whether to show error styling on the button */
  showButtonError: boolean
  /** Whether this is an existing draft (has pst- prefix) */
  isExistingDraft: boolean
}

/**
 * Hook for managing draft process execution persistence.
 * Handles saving drafts to RxDB, discarding, and calculating field completion.
 */
export const useDraftProcessSave = ({
  draftId,
  draftCollection,
  processId,
  name,
  startStepPath,
  totalFields,
  jsonSchema,
  clearLocalStorage,
  onDiscard,
}: UseDraftProcessSaveOptions): UseDraftProcessSaveResult => {
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null)
  const [showButtonError, setShowButtonError] = useState(false)

  // Auto-clear button error state after 2.5 seconds with proper cleanup
  useEffect(() => {
    if (!showButtonError) return
    const timer = setTimeout(() => setShowButtonError(false), 2500)
    return () => clearTimeout(timer)
  }, [showButtonError])

  // Check if we're continuing from an existing draft (draftId starts with "pst-")
  const isExistingDraft = draftId.startsWith("pst-")

  // Memoize validator to avoid recreating on every render
  const validator = useMemo(
    () => createStandardSchemaFromJsonSchema(jsonSchema),
    [jsonSchema],
  )

  // Calculate fieldsCompleted by counting fields without validation errors
  const calculateFieldsCompleted = useCallback(
    (values: Record<string, unknown>) => {
      const validationResult = (
        validator as StandardSchemaV1<Record<string, unknown>>
      )["~standard"].validate(values)
      // If validator is async (returns Promise), assume all fields valid for now
      if (validationResult instanceof Promise) {
        return totalFields
      }
      // Count unique top-level fields with errors
      // Path elements can be PropertyKey (string|number|symbol) or PathSegment ({key: PropertyKey})
      const fieldsWithErrors = new Set(
        validationResult.issues
          ?.map((issue) => {
            const segment = issue.path?.[0]
            if (segment === undefined) return undefined
            return typeof segment === "object" &&
              segment !== null &&
              "key" in segment
              ? segment.key
              : segment
          })
          .filter(Boolean) ?? [],
      ).size
      return totalFields - fieldsWithErrors
    },
    [validator, totalFields],
  )

  const handleSaveDraft = useCallback(
    async (values: Record<string, unknown>) => {
      // Clear previous error state
      setDraftSaveError(null)
      setShowButtonError(false)

      try {
        // Generate a fresh ID for each save invocation unless updating a draft.
        const id = createDraftId(draftId)
        const exists = draftCollection.has(id)
        const fieldsCompleted = calculateFieldsCompleted(values)

        if (exists) {
          const tx = draftCollection.update(id, (draft) => {
            draft.state = values
            draft.fieldsCompleted = fieldsCompleted
            draft.updatedAt = Date.now()
            draft.lastSaved = new Date().toISOString()
          })
          await tx.isPersisted.promise
        } else {
          const tx = draftCollection.insert({
            id,
            processId,
            name,
            startStepPath,
            state: values,
            fieldsCompleted,
            totalFields,
            updatedAt: Date.now(),
            lastSaved: new Date().toISOString(),
          })
          await tx.isPersisted.promise
        }
        clearLocalStorage()
        // Silent save - no user feedback on success
      } catch (error) {
        // Set error message for display
        const message =
          error instanceof Error
            ? `Failed to save draft: ${error.message}`
            : "Failed to save draft. Please try again."
        setDraftSaveError(message)

        // Flash button red (cleared by useEffect after 2.5s)
        setShowButtonError(true)

        // Keep console logging
        console.error("Draft save failed:", error)
      }
    },
    [
      draftCollection,
      draftId,
      processId,
      name,
      startStepPath,
      totalFields,
      calculateFieldsCompleted,
      clearLocalStorage,
    ],
  )

  const handleDiscard = useCallback(() => {
    clearLocalStorage()
    // Delete the draft from RxDB if it exists
    if (isExistingDraft && draftCollection.has(draftId)) {
      draftCollection.delete(draftId)
    }
    onDiscard()
  }, [clearLocalStorage, isExistingDraft, draftCollection, draftId, onDiscard])

  return {
    handleSaveDraft,
    handleDiscard,
    calculateFieldsCompleted,
    draftSaveError,
    showButtonError,
    isExistingDraft,
  }
}
