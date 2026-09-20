export const RESTART_EXECUTION_GENERIC_ERROR = "Failed to restart execution"
export const RESTART_EXECUTION_PENDING_LABEL = "Restarting..."

export type RestartExecutionMutationResult = {
  readonly success: boolean
  readonly restartedCount?: number | null
  readonly error?: string | null
}

export type RestartExecutionOutcome =
  | { readonly type: "success"; readonly message: string }
  | { readonly type: "error"; readonly message: string }

/**
 * Build the user-visible success message for a restart mutation.
 * Includes the restarted-step count when the resolver provides it.
 */
export function formatRestartSuccessMessage(
  restartedCount: number | null | undefined,
): string {
  if (typeof restartedCount === "number") {
    return `Restarted ${restartedCount} failed step(s)`
  }
  return "Execution restarted successfully"
}

/**
 * Prefer the resolver-provided error; fall back to a safe generic message.
 */
export function formatRestartFailureMessage(
  error: string | null | undefined,
): string {
  if (error !== undefined && error !== null && error.length > 0) {
    return error
  }
  return RESTART_EXECUTION_GENERIC_ERROR
}

/**
 * Run a restart mutation and report pending / success / failure outcomes.
 * Duplicate submissions while pending are ignored. Pending is always cleared
 * in `finally`, independent of subscription refresh.
 */
export async function runRestartExecution(options: {
  readonly isPending: boolean
  readonly restart: () => Promise<RestartExecutionMutationResult>
  readonly onPendingChange: (isPending: boolean) => void
  readonly onOutcome: (outcome: RestartExecutionOutcome) => void
}): Promise<void> {
  if (options.isPending) {
    return
  }

  options.onPendingChange(true)
  try {
    const result = await options.restart()
    if (result.success) {
      options.onOutcome({
        type: "success",
        message: formatRestartSuccessMessage(result.restartedCount),
      })
      return
    }
    options.onOutcome({
      type: "error",
      message: formatRestartFailureMessage(result.error),
    })
  } catch {
    options.onOutcome({
      type: "error",
      message: RESTART_EXECUTION_GENERIC_ERROR,
    })
  } finally {
    options.onPendingChange(false)
  }
}
