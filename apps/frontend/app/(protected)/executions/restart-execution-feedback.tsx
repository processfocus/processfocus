import {
  RESTART_EXECUTION_PENDING_LABEL,
  type RestartExecutionOutcome,
} from "@/lib/restart-execution-action"
import { cn } from "@/lib/utils"

/**
 * Accessible restart outcome UI that lives outside the dropdown so feedback
 * remains visible after the menu closes and without waiting on RxDB refresh.
 */
export function RestartExecutionFeedback({
  isRestarting,
  outcome,
}: {
  readonly isRestarting: boolean
  readonly outcome: RestartExecutionOutcome | null
}) {
  if (!isRestarting && outcome === null) {
    return null
  }

  return (
    <div
      role={outcome?.type === "error" ? "alert" : "status"}
      aria-live={outcome?.type === "error" ? "assertive" : "polite"}
      aria-busy={isRestarting}
      data-testid="restart-execution-feedback"
      className={cn(
        "max-w-[16rem] text-right text-xs leading-snug",
        isRestarting && "text-slate-500 dark:text-slate-400",
        outcome?.type === "success" && "text-emerald-600 dark:text-emerald-400",
        outcome?.type === "error" && "text-rose-600 dark:text-rose-400",
      )}
    >
      {isRestarting
        ? RESTART_EXECUTION_PENDING_LABEL
        : (outcome?.message ?? null)}
    </div>
  )
}
