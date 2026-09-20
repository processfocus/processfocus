"use client"

import type { FormActionsContext } from "@pf/form"
import { Button } from "@pf/shadcn-components"

interface TodoFormActionsProps {
  /** Form actions context from dynamicForm's renderActions callback */
  context: FormActionsContext
}

/**
 * Action buttons for todo completion forms.
 * Renders Done without draft persistence.
 */
export function TodoFormActions({ context }: TodoFormActionsProps) {
  const { formState } = context
  const { isSubmitting } = formState

  return (
    <div className="flex justify-end gap-3">
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "..." : "Done"}
      </Button>
    </div>
  )
}
