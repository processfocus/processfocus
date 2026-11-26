import { setTimeout as sleep } from "node:timers/promises"
import { Effect } from "effect"
import { CliError } from "../errors"
import { isWorkloadAuthenticationFailure } from "./credentials"
import type {
  ExecutionEventSource,
  ExecutionSnapshot,
  ExecutionStatus,
  ExecutionStepStatus,
} from "./execution-subscription"
import { ExecutionSubscriptionDisconnected } from "./execution-subscription"

const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "Completed",
  "Failed",
  "Abandoned",
])
const VISIBLE_STEP_STATUSES: ReadonlySet<ExecutionStepStatus> = new Set([
  "Waiting",
  "Completed",
  "Failed",
])

interface WaitForExecutionOptions {
  readonly executionLabel: string
  readonly timeoutMs: number
  readonly heartbeatMs: number
  readonly hasPendingInitialLine: boolean
  readonly formatLogMessage: (message: string, now?: number) => string
  readonly quiet?: boolean
  /** Activity from a companion progress stream; does not delay snapshot recovery. */
  readonly getLastProgressAt?: () => number
  readonly includeExecutionIdInTimeout?: boolean
  /**
   * Resolves the persisted execution snapshot when the live event stream goes
   * quiet for timeoutMs or disconnects. Deployments can legitimately stay silent
   * longer than the update timeout (for example a slow CloudFront invalidation while
   * promoting), so the persisted state decides whether the wait continues
   * instead of the absence of events.
   */
  readonly fetchSnapshot?: (signal: AbortSignal) => Promise<ExecutionSnapshot>
  /**
   * Wait ceiling checked after snapshot recovery, including failed reads.
   * Defaults to three times timeoutMs.
   */
  readonly maxWaitMs?: number
}

const formatExecutionWaitTimeoutMessage = (
  timeoutMs: number,
  executionLabel: string,
  executionId: string,
  includeExecutionId: boolean,
) => {
  const minutes = Math.round(timeoutMs / 60_000)
  const minuteLabel = minutes === 1 ? "minute" : "minutes"
  const suffix = includeExecutionId
    ? ` for ${executionLabel} ${executionId}`
    : ""

  return `Timeout: No ${executionLabel} update received in the last ${minutes} ${minuteLabel}${suffix}`
}

const renderExecutionUpdateLines = (
  previous: ExecutionSnapshot | undefined,
  current: ExecutionSnapshot,
): string[] => {
  const lines: string[] = []

  if (!previous || previous.status !== current.status) {
    lines.push(
      previous
        ? `Status: ${previous.status} -> ${current.status}`
        : `Status: ${current.status}`,
    )
  }

  const previousStepStatus = new Map(
    previous?.steps.map((step) => [step.path, step.status]) ?? [],
  )

  for (const step of current.steps) {
    if (!VISIBLE_STEP_STATUSES.has(step.status)) {
      continue
    }

    const priorStatus = previousStepStatus.get(step.path)
    if (!previous) {
      if (step.status === "Waiting" || step.status === "Failed") {
        lines.push(`Step ${step.name}: ${step.status}`)
      }
      continue
    }

    if (priorStatus !== step.status) {
      lines.push(`Step ${step.name}: ${step.status}`)
    }
  }

  return lines
}

const nextUpdateWithTimeout = async <T>(
  nextUpdate: Promise<IteratorResult<T>>,
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal,
): Promise<IteratorResult<T>> =>
  await new Promise<IteratorResult<T>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    const abort = () => {
      clearTimeout(timeout)
      reject(new Error("Execution wait cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    nextUpdate
      .then((result) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        reject(error)
      })
  })

export const waitForExecutionToFinish = (
  executionEventSource: ExecutionEventSource,
  executionId: string,
  options: WaitForExecutionOptions,
): Effect.Effect<ExecutionSnapshot, CliError> =>
  Effect.tryPromise({
    try: async (signal) => {
      let previousExecution: ExecutionSnapshot | undefined
      let lastEventTime = Date.now()
      const waitStartedAt = Date.now()
      let lastActivityAt = waitStartedAt
      let lastInactivityWarningAt = waitStartedAt
      let hasPendingLine = options.hasPendingInitialLine
      const iterator = executionEventSource[Symbol.asyncIterator]()
      const timeoutMessage = formatExecutionWaitTimeoutMessage(
        options.timeoutMs,
        options.executionLabel,
        executionId,
        options.includeExecutionIdInTimeout ?? false,
      )
      const heartbeat = setInterval(() => {
        if (!options.quiet) {
          process.stdout.write(".")
          hasPendingLine = true
        }
      }, options.heartbeatMs)
      const maxWaitMs = options.maxWaitMs ?? options.timeoutMs * 3
      let streamDisconnected = false
      let lastSnapshotErrorMessage: string | undefined

      const printLine = (line: string, now: number) => {
        if (hasPendingLine) {
          process.stdout.write("\n")
          hasPendingLine = false
        }
        console.log(options.formatLogMessage(line, now))
      }

      const stopLiveStream = async (message: string) => {
        streamDisconnected = true
        printLine(
          `${message}; polling persisted ${options.executionLabel} status.`,
          Date.now(),
        )
        try {
          await executionEventSource.close()
        } catch (error) {
          if (signal.aborted) throw error
          printLine(
            `Could not close execution subscription: ${error instanceof Error ? error.message : String(error)}; continuing with persisted status.`,
            Date.now(),
          )
        }
      }

      const printExecutionUpdate = (
        execution: ExecutionSnapshot,
        now: number,
      ) => {
        const lines = options.quiet
          ? []
          : renderExecutionUpdateLines(previousExecution, execution)
        if (lines.length > 0) {
          if (hasPendingLine) {
            process.stdout.write("\n")
            hasPendingLine = false
          }
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i]
            if (line) {
              console.log(options.formatLogMessage(line, now))
            }
          }

          const lastLine = lines[lines.length - 1]
          if (lastLine) {
            process.stdout.write(options.formatLogMessage(lastLine, now))
            hasPendingLine = true
          }
        }
      }

      const returnTerminalExecution = (
        execution: ExecutionSnapshot,
        now: number,
      ) => {
        printExecutionUpdate(execution, now)
        if (hasPendingLine) {
          process.stdout.write("\n")
          hasPendingLine = false
        }
        return execution
      }

      // Recovers a silent or disconnected stream: the persisted snapshot decides
      // whether the execution finished, is still running, or the wait must
      // give up. Returns undefined to keep waiting for a terminal result.
      const recoverWithSnapshot = async (
        now: number,
      ): Promise<ExecutionSnapshot | undefined> => {
        if (!options.fetchSnapshot) {
          throw new Error(timeoutMessage)
        }

        let snapshot: ExecutionSnapshot | undefined
        try {
          snapshot = await options.fetchSnapshot(signal)
        } catch (error) {
          if (signal.aborted || isWorkloadAuthenticationFailure(error)) {
            throw error
          }
          if (Date.now() - waitStartedAt >= maxWaitMs) {
            throw new Error(
              `${timeoutMessage}; could not read ${options.executionLabel} ${executionId} status: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
          // A transient snapshot failure must not fail an otherwise healthy
          // deployment; the next recovery attempt tries again. Avoid repeating
          // the same warning on every poll during an outage.
          const message = error instanceof Error ? error.message : String(error)
          if (message !== lastSnapshotErrorMessage) {
            printLine(
              `Could not read ${options.executionLabel} status: ${message}; continuing to wait.`,
              now,
            )
            lastSnapshotErrorMessage = message
          }
          return undefined
        }
        lastSnapshotErrorMessage = undefined

        if (snapshot.id !== executionId) {
          throw new Error(timeoutMessage)
        }

        if (TERMINAL_EXECUTION_STATUSES.has(snapshot.status)) {
          return returnTerminalExecution(snapshot, now)
        }

        if (Date.now() - waitStartedAt >= maxWaitMs) {
          throw new Error(
            `${timeoutMessage}; ${options.executionLabel} ${executionId} was still ${snapshot.status}`,
          )
        }

        if (streamDisconnected) {
          printExecutionUpdate(snapshot, now)
        }
        // Polling and heartbeat output are not new activity. Read the clock after
        // the query, since progress can arrive while the snapshot is in flight.
        const reportedAt = Date.now()
        const inactiveMs =
          reportedAt -
          Math.max(
            lastActivityAt,
            options.getLastProgressAt?.() ?? waitStartedAt,
          )
        if (
          inactiveMs >= options.timeoutMs &&
          reportedAt - lastInactivityWarningAt >= options.timeoutMs
        ) {
          printLine(
            `No ${options.executionLabel} updates for ${Math.round(
              inactiveMs / 60_000,
            )} minutes; ${options.executionLabel} is still ${snapshot.status}; continuing to wait.`,
            reportedAt,
          )
          lastInactivityWarningAt = reportedAt
        }
        previousExecution = snapshot
        return undefined
      }

      let pendingUpdate: Promise<IteratorResult<ExecutionSnapshot>> | undefined
      try {
        while (true) {
          signal.throwIfAborted()
          if (streamDisconnected) {
            const recovered = await recoverWithSnapshot(Date.now())
            if (recovered) return recovered
            await sleep(Math.min(5_000, options.timeoutMs), undefined, {
              signal,
            })
            continue
          }
          let nextResult: IteratorResult<ExecutionSnapshot>
          try {
            // A timeout does not cancel next(): reuse it so a resumed stream
            // cannot deliver its terminal event to an abandoned read.
            pendingUpdate ??= iterator.next()
            nextResult = await nextUpdateWithTimeout(
              pendingUpdate,
              options.timeoutMs,
              timeoutMessage,
              signal,
            )
          } catch (error) {
            if (error instanceof Error && error.message === timeoutMessage) {
              const recovered = await recoverWithSnapshot(Date.now())
              if (recovered) {
                return recovered
              }
              continue
            }
            if (
              error instanceof ExecutionSubscriptionDisconnected &&
              options.fetchSnapshot
            ) {
              pendingUpdate = undefined
              await stopLiveStream(error.message)
              continue
            }
            throw error
          }
          pendingUpdate = undefined

          if (nextResult.done) {
            if (options.fetchSnapshot) {
              await stopLiveStream("Execution update stream ended")
              continue
            }
            throw new Error(
              `Execution update stream ended before ${options.executionLabel} finished: ${executionId}`,
            )
          }

          const execution = nextResult.value
          const now = Date.now()

          if (execution.id !== executionId) {
            if (now - lastEventTime > options.timeoutMs) {
              // Other executions must not bypass persisted-status recovery.
              const recovered = await recoverWithSnapshot(now)
              if (recovered) return recovered
              lastEventTime = Date.now()
            }
            continue
          }

          lastEventTime = now
          lastActivityAt = now

          if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
            return returnTerminalExecution(execution, now)
          }

          printExecutionUpdate(execution, now)
          previousExecution = execution
        }
      } finally {
        clearInterval(heartbeat)
      }
    },
    catch: (cause) =>
      new CliError({
        message: `Failed while waiting for ${options.executionLabel} completion: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  })

export const extractExecutionFailureMessage = (
  execution: ExecutionSnapshot,
): string | undefined => {
  const failedStepReason = execution.steps.find(
    (step) => step.status === "Failed",
  )?.failureReason

  return (
    failedStepReason ??
    execution.failureReason ??
    execution.abandonedReason ??
    undefined
  )
}
