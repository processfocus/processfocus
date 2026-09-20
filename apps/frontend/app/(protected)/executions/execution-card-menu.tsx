"use client"

import { Ban, Download, MoreVertical, RotateCcw, Search } from "lucide-react"
import { useRouter } from "next/navigation"
import { useMemo, useRef, useState } from "react"
import { AbandonExecutionDialog } from "./abandon-execution-dialog"
import { RestartExecutionFeedback } from "./restart-execution-feedback"
import { useFeaturePermissions } from "@/components/feature-permissions-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  type ExecutionMenuActionRegistration,
  listExecutionMenuActions,
} from "@/lib/execution-menu-actions-registry"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { restartExecution } from "@/lib/graphql/execution-queries"
import {
  RESTART_EXECUTION_PENDING_LABEL,
  type RestartExecutionOutcome,
  runRestartExecution,
} from "@/lib/restart-execution-action"

interface ExecutionCardMenuProps {
  executionId: string
  status: string
  processPath?: string
  canAbandonExecution: boolean
  canRestartExecution: boolean
}

/**
 * Whether the execution card menu shell should stay mounted.
 * Feedback must remain visible after a successful restart even when live
 * status leaves Failed and the kebab has no remaining actions.
 */
export function shouldRenderExecutionCardMenu(options: {
  readonly hasMenuActions: boolean
  readonly isRestarting: boolean
  readonly restartOutcome: RestartExecutionOutcome | null
}): boolean {
  return (
    options.hasMenuActions ||
    options.isRestarting ||
    options.restartOutcome !== null
  )
}

/** Abandon is allowed for Running and Failed when Cedar grants `canAbandonExecution`. */
export function canShowAbandonExecution(options: {
  readonly status: string
  readonly canAbandonExecution: boolean
}): boolean {
  return (
    (options.status === "Running" || options.status === "Failed") &&
    options.canAbandonExecution
  )
}

export function ExecutionCardMenu({
  executionId,
  status,
  processPath,
  canAbandonExecution,
  canRestartExecution,
}: ExecutionCardMenuProps) {
  const router = useRouter()
  const { showProcessState } = useFeaturePermissions()
  const [abandonDialogOpen, setAbandonDialogOpen] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [restartOutcome, setRestartOutcome] =
    useState<RestartExecutionOutcome | null>(null)
  const isRestartingRef = useRef(false)
  const [busyActionId, setBusyActionId] = useState<string | null>(null)
  const client = useGraphqlClient()
  const canCancelExecution = canShowAbandonExecution({
    status,
    canAbandonExecution,
  })
  const canShowRestartExecution = status === "Failed" && canRestartExecution

  const pluginActions = useMemo(() => {
    if (processPath === undefined)
      return [] as ExecutionMenuActionRegistration[]
    const visibility = {
      executionId,
      processPath,
      status,
      showProcessState,
    }
    return listExecutionMenuActions().filter((action) =>
      action.isVisible(visibility),
    )
  }, [executionId, processPath, showProcessState, status])

  const hasMenuActions =
    showProcessState ||
    canCancelExecution ||
    canShowRestartExecution ||
    pluginActions.length > 0

  if (
    !shouldRenderExecutionCardMenu({
      hasMenuActions,
      isRestarting,
      restartOutcome,
    })
  ) {
    return null
  }

  const handleRestart = async () => {
    setRestartOutcome(null)
    await runRestartExecution({
      isPending: isRestartingRef.current,
      restart: () => restartExecution(client, executionId),
      onPendingChange: (pending) => {
        isRestartingRef.current = pending
        setIsRestarting(pending)
      },
      onOutcome: setRestartOutcome,
    })
  }

  const handlePluginAction = async (
    action: ExecutionMenuActionRegistration,
  ) => {
    if (processPath === undefined) return
    setBusyActionId(action.id)
    try {
      await action.onSelect({
        executionId,
        processPath,
        status,
        showProcessState,
        request: (document, variables) =>
          client.request(document, variables ?? {}),
      })
    } catch (error) {
      console.error(`Failed to run execution menu action "${action.id}"`, error)
    }
    setBusyActionId(null)
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        {hasMenuActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              {showProcessState && (
                <DropdownMenuItem
                  onSelect={() =>
                    router.push(
                      `/executions/${encodeURIComponent(executionId)}/process-state?from=executions`,
                      { scroll: false },
                    )
                  }
                >
                  <Search className="mr-2 h-4 w-4" />
                  Show process state
                </DropdownMenuItem>
              )}
              {pluginActions.map((action) => {
                const busy = busyActionId === action.id
                return (
                  <DropdownMenuItem
                    key={action.id}
                    onSelect={() => {
                      void handlePluginAction(action)
                    }}
                    disabled={busy}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {busy ? (action.busyLabel ?? action.label) : action.label}
                  </DropdownMenuItem>
                )
              })}
              {canCancelExecution && (
                <DropdownMenuItem
                  onSelect={() => setAbandonDialogOpen(true)}
                  className="text-rose-600 focus:text-rose-600"
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Cancel execution
                </DropdownMenuItem>
              )}
              {canShowRestartExecution && (
                <DropdownMenuItem
                  onSelect={() => {
                    void handleRestart()
                  }}
                  disabled={isRestarting}
                  className="text-rose-600 focus:text-rose-600"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {isRestarting
                    ? RESTART_EXECUTION_PENDING_LABEL
                    : "Restart execution"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <RestartExecutionFeedback
          isRestarting={isRestarting}
          outcome={restartOutcome}
        />
      </div>
      <AbandonExecutionDialog
        executionId={executionId}
        open={abandonDialogOpen}
        onOpenChange={setAbandonDialogOpen}
      />
    </>
  )
}
