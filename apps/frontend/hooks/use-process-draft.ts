"use client"

import type { Collection } from "@tanstack/db"
import { useCallback, useEffect, useRef, useState } from "react"
import { ulid } from "ulidx"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"

type DraftCollection = Collection<DraftProcessExecutionDocType, string>
const AUTOSAVE_DELAY_MS = 300

type PendingEdit = {
  values: Record<string, unknown>
  clearLocalStorage: () => void
}

const pendingByCollection = new WeakMap<
  DraftCollection,
  Map<string, Promise<void>>
>()

function enqueueDraftWrite(
  collection: DraftCollection,
  processId: string,
  write: (isLatest: () => boolean) => Promise<void>,
) {
  let pending = pendingByCollection.get(collection)
  if (!pending) {
    pending = new Map()
    pendingByCollection.set(collection, pending)
  }
  const writes = pending
  const isLatest = () => writes.get(processId) === current
  const previous = writes.get(processId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => write(isLatest))
  writes.set(processId, current)
  const remove = () => {
    if (isLatest()) writes.delete(processId)
  }
  void current.then(remove, remove)
  return current
}

export function findProcessDraft(
  collection: DraftCollection,
  processId: string,
): DraftProcessExecutionDocType | undefined {
  let latest: DraftProcessExecutionDocType | undefined
  for (const draft of collection.values()) {
    if (
      draft.processId === processId &&
      (!latest ||
        draft.updatedAt > latest.updatedAt ||
        (draft.updatedAt === latest.updatedAt && draft.id > latest.id))
    ) {
      latest = draft
    }
  }
  return latest
}

export function useProcessDraft({
  collection,
  processId,
  name,
  startStepPath,
  totalFields,
}: {
  collection: DraftCollection | undefined
  processId: string
  name: string
  startStepPath: string
  totalFields: number
}) {
  const [error, setError] = useState<string | null>(null)
  const [isDiscarding, setIsDiscarding] = useState(false)
  const edit = useRef<PendingEdit | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearing = useRef(false)

  const takeEdit = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    const pendingEdit = edit.current
    edit.current = null
    return pendingEdit
  }, [])

  const flush = useCallback(() => {
    const pendingEdit = takeEdit()
    if (!collection || !pendingEdit) return
    const { values, clearLocalStorage } = pendingEdit
    // Serialize writes across openings of this process in the same browser.
    void enqueueDraftWrite(collection, processId, async (isLatest) => {
      const draft = findProcessDraft(collection, processId)
      const now = new Date()
      const tx = draft
        ? collection.update(draft.id, (row) => {
            row.state = values
            row.updatedAt = now.getTime()
            row.lastSaved = now.toISOString()
          })
        : collection.insert({
            id: `pst-${ulid()}`,
            processId,
            name,
            startStepPath,
            state: values,
            fieldsCompleted: 0,
            totalFields,
            updatedAt: now.getTime(),
            lastSaved: now.toISOString(),
          })
      await tx.when("settled")
      if (isLatest() && !edit.current) clearLocalStorage()
      setError(null)
    }).catch((cause: unknown) => {
      setError(
        "Changes couldn't be saved. Your edits are still in this browser.",
      )
      console.error("Draft save failed:", cause)
    })
  }, [collection, processId, name, startStepPath, takeEdit, totalFields])

  // The renderer stores edits in this browser immediately. Persist the last
  // one on normal navigation rather than waiting for the debounce to expire.
  useEffect(() => {
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [flush])

  const save = useCallback(
    (values: Record<string, unknown>, clearLocalStorage: () => void) => {
      if (!collection || clearing.current) return
      edit.current = { values, clearLocalStorage }
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS)
    },
    [collection, flush],
  )

  const clear = useCallback(async () => {
    if (clearing.current) return false
    clearing.current = true
    setIsDiscarding(true)
    const pendingEdit = takeEdit()
    try {
      if (collection) {
        await enqueueDraftWrite(collection, processId, async () => {
          // Clearing a form must not fall back to a pre-existing duplicate.
          const ids = [...collection.values()]
            .filter((draft) => draft.processId === processId)
            .map((draft) => draft.id)
          if (ids.length > 0) await collection.delete(ids).when("settled")
        })
      }
      // All successful callers leave the form; edits must not recreate it
      // between clearing the saved values and closing the form.
      return true
    } catch (cause) {
      clearing.current = false
      setIsDiscarding(false)
      if (pendingEdit) save(pendingEdit.values, pendingEdit.clearLocalStorage)
      setError("Couldn't clear the saved form. Please try again.")
      console.error("Draft cleanup failed:", cause)
      return false
    }
  }, [collection, processId, save, takeEdit])

  return { save, clear, error, isDiscarding }
}
