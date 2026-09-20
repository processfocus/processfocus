"use client"

import type { Collection } from "@tanstack/db"
import type { FormActionsContext, JsonSchemaRoot } from "@pf/form"
import { Button } from "@pf/shadcn-components"
import { ProcessSubmitButton } from "./process-submit-button"
import { useDraftProcessSave } from "@/hooks/use-draft-process-save"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"

interface ProcessFormActionsProps {
  canSkipScheduleWaits: boolean
  /** Form actions context from dynamicForm's renderActions callback */
  context: FormActionsContext
  /** RxDB draft collection */
  draftCollection: Collection<DraftProcessExecutionDocType, string>
  /** Draft ID (may or may not have pst- prefix) */
  draftId: string
  /** Database process ID */
  processId: string
  /** Process name for draft metadata */
  name: string
  /** Start step path for draft metadata */
  startStepPath: string
  /** Total number of form fields for progress tracking */
  totalFields: number
  /** JSON Schema for validation */
  jsonSchema: JsonSchemaRoot
  /** Called after discard to navigate away */
  onDiscard: () => void
}

/**
 * Shared action buttons for process start forms.
 * Renders Discard, Save draft, and Submit buttons with draft persistence logic.
 */
export function ProcessFormActions({
  canSkipScheduleWaits,
  context,
  draftCollection,
  draftId,
  processId,
  name,
  startStepPath,
  totalFields,
  jsonSchema,
  onDiscard,
}: ProcessFormActionsProps) {
  const { formState, clearLocalStorage } = context
  const { isSubmitting, values } = formState

  const { handleSaveDraft, handleDiscard, draftSaveError, showButtonError } =
    useDraftProcessSave({
      draftId,
      draftCollection,
      processId,
      name,
      startStepPath,
      totalFields,
      jsonSchema,
      clearLocalStorage,
      onDiscard,
    })

  return (
    <div className="space-y-3">
      <div className="flex justify-between gap-3">
        <div className="flex gap-3">
          {/* preventDefault on pointerdown stops the browser from blurring
              the focused input before onClick fires. Without this, blur
              triggers validation which flashes errors for one frame before
              handleDiscard navigates away.
              Uses pointerdown (not mousedown) to cover both mouse and touch.
              Side effects (no focus transfer, no text selection on the button)
              are acceptable since this button navigates away immediately. */}
          <Button
            type="button"
            variant="outline"
            onClick={handleDiscard}
            onPointerDown={(e) => e.preventDefault()}
          >
            Discard
          </Button>
          <Button
            type="button"
            variant={showButtonError ? "destructive" : "secondary"}
            onClick={() => handleSaveDraft(values)}
          >
            Save draft
          </Button>
        </div>
        <ProcessSubmitButton
          canSkipScheduleWaits={canSkipScheduleWaits}
          isSubmitting={isSubmitting}
        />
      </div>
      {draftSaveError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-800 dark:bg-rose-900/20">
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {draftSaveError}
          </p>
        </div>
      )}
    </div>
  )
}
