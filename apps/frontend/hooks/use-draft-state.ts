import type { Collection } from "@tanstack/db"
import { eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { use } from "react"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"
import { useDraftProcessCollection } from "@/lib/collections/draft-process-execution-collection-provider"

interface UseDraftStateResult {
  /** The saved draft state merged with default values, or just default values if no draft */
  mergedDefaultValues: Record<string, unknown> | null
  /** Whether the draft query is still loading */
  isLoading: boolean
  /** Whether the draft query encountered an error */
  isError: boolean
}

/**
 * Shared hook implementation that loads draft state from RxDB and merges with default values.
 */
const useDraftStateLiveQuery = (
  draftCollection: Collection<DraftProcessExecutionDocType, string>,
  draftId: string | undefined,
  defaultValues: Record<string, unknown> | null,
): UseDraftStateResult => {
  const isExistingDraft = draftId?.startsWith("pst-") ?? false

  // Only query when we have an existing draft to continue
  // Use findOne() with where clause for efficient single-document lookup
  const draftQuery = useLiveQuery(
    (q) =>
      isExistingDraft
        ? q
            .from({ draft: draftCollection })
            .where(({ draft }) => eq(draft.id, draftId))
            .select(({ draft }) => ({
              state: draft.state,
            }))
            .findOne()
        : null,
    [draftId, isExistingDraft],
  )

  // Get the saved state from the draft (findOne returns single item or undefined)
  const savedDraftState =
    isExistingDraft && draftQuery.isReady && draftQuery.data
      ? (draftQuery.data.state as Record<string, unknown>)
      : undefined

  // Merge saved draft state with default values (draft state takes precedence)
  const mergedDefaultValues = savedDraftState
    ? { ...defaultValues, ...savedDraftState }
    : defaultValues

  return {
    mergedDefaultValues,
    isLoading: isExistingDraft && !draftQuery.isReady && !draftQuery.isError,
    isError: draftQuery.isError ?? false,
  }
}

/**
 * Hook to load draft state from RxDB and merge with schema default values.
 *
 * When continuing from an existing draft (draftId starts with "pst-"),
 * this hook loads the saved form state and merges it with the schema's
 * default values, with draft state taking precedence.
 *
 * IMPORTANT: This hook uses React's use() to suspend until the collection is ready.
 * Components using this hook MUST be wrapped in a Suspense boundary.
 */
export const useDraftState = (
  draftId: string | undefined,
  defaultValues: Record<string, unknown> | null,
): UseDraftStateResult => {
  const { collectionPromise } = useDraftProcessCollection()
  const draftCollection = use(collectionPromise)

  return useDraftStateLiveQuery(draftCollection, draftId, defaultValues)
}
