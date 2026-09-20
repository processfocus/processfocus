"use client"

import { Ban } from "lucide-react"
import { useState } from "react"
import { Button } from "@pf/shadcn-components"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { abandonExecution } from "@/lib/graphql/execution-queries"

export const ABANDON_EXECUTION_DIALOG_TITLE = "Cancel execution"
export const ABANDON_EXECUTION_DIALOG_DESCRIPTION =
  "This will permanently cancel the execution and mark it as abandoned. All active todos and scheduled flows will be cancelled."
export const ABANDON_EXECUTION_REASON_PLACEHOLDER =
  "Why are you cancelling this execution?"
export const ABANDON_EXECUTION_CONFIRM_LABEL = "Cancel execution"
export const ABANDON_EXECUTION_PENDING_LABEL = "Cancelling..."
export const ABANDON_EXECUTION_FAILED_MESSAGE = "Failed to cancel execution"

interface AbandonExecutionDialogProps {
  executionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AbandonExecutionDialog({
  executionId,
  open,
  onOpenChange,
}: AbandonExecutionDialogProps) {
  const [reason, setReason] = useState("")
  const [isAbandoning, setIsAbandoning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useGraphqlClient()

  const handleClose = () => {
    if (!isAbandoning) {
      setReason("")
      setError(null)
      onOpenChange(false)
    }
  }

  const handleAbandon = async () => {
    if (!client) return
    setIsAbandoning(true)
    setError(null)
    let abandonReason: string | undefined
    if (reason) {
      abandonReason = reason
    }
    try {
      const result = await abandonExecution(client, executionId, abandonReason)
      if (result.success) {
        setReason("")
        onOpenChange(false)
      } else {
        let errorMessage = ABANDON_EXECUTION_FAILED_MESSAGE
        if (result.error) {
          errorMessage = result.error
        }
        setError(errorMessage)
      }
    } catch (_err) {
      setError(ABANDON_EXECUTION_FAILED_MESSAGE)
    }
    setIsAbandoning(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-600">
            <Ban className="h-5 w-5" />
            {ABANDON_EXECUTION_DIALOG_TITLE}
          </DialogTitle>
          <DialogDescription>
            {ABANDON_EXECUTION_DIALOG_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label
              htmlFor="abandon-reason"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Reason (optional)
            </label>
            <textarea
              id="abandon-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={ABANDON_EXECUTION_REASON_PLACEHOLDER}
              className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isAbandoning}
            />
          </div>

          {error && (
            <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-600">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isAbandoning}
          >
            Go back
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleAbandon}
            disabled={isAbandoning}
          >
            {isAbandoning
              ? ABANDON_EXECUTION_PENDING_LABEL
              : ABANDON_EXECUTION_CONFIRM_LABEL}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
