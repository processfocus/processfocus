"use client"

import { useQuery } from "@tanstack/react-query"
import { CopyButton } from "@/components/copy-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { fetchProcessStateForExecution } from "@/lib/graphql/execution-queries"

interface ProcessStateDialogProps {
  executionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProcessStateDialog({
  executionId,
  open,
  onOpenChange,
}: ProcessStateDialogProps) {
  const client = useGraphqlClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ["processState", executionId],
    queryFn: () => fetchProcessStateForExecution(client, executionId),
    enabled: open,
  })
  const processStateJson = data == null ? null : JSON.stringify(data, null, 2)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-1 pr-8 leading-snug">
            <span className="break-all">Process state {executionId}</span>
            <CopyButton
              value={executionId}
              label="Copy process state ID"
              className="mt-1 p-0.5 opacity-70 hover:opacity-100"
              iconClassName="h-3.5 w-3.5"
            />
          </DialogTitle>
          <DialogDescription>
            Raw process state JSON for debugging purposes.
          </DialogDescription>
        </DialogHeader>

        <div className="relative overflow-auto rounded-md bg-slate-100 p-4 dark:bg-slate-800">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            </div>
          )}

          {error && (
            <div className="text-red-600 dark:text-red-400">
              <p className="font-medium">Error loading process state</p>
              <p className="text-sm">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          )}

          {!isLoading && !error && data === null && (
            <p className="text-slate-500 dark:text-slate-400">
              No process state found for this execution.
            </p>
          )}

          {!isLoading && !error && processStateJson != null && (
            <>
              <CopyButton
                value={processStateJson}
                label="Copy process state JSON"
                className="absolute top-3 right-3 bg-slate-100/90 dark:bg-slate-800/90"
              />
              <pre className="max-h-[50vh] overflow-auto pr-8 text-xs text-slate-700 dark:text-slate-300">
                {processStateJson}
              </pre>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
