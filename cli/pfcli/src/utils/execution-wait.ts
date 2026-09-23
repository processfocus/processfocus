import { Effect } from "effect"
import { CliError } from "../errors"
import type {
  ExecutionEventSource,
  ExecutionSnapshot,
  ExecutionStatus,
  ExecutionStepStatus,
} from "./execution-subscription"

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
  readonly includeExecutionIdInTimeout?: boolean
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
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal,
): Promise<IteratorResult<T>> =>
  await new Promise<IteratorResult<T>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    const abort = () => {
      clearTimeout(timeout)
      reject(new Error("Execution wait cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
    iterator
      .next()
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

      try {
        while (true) {
          const nextResult = await nextUpdateWithTimeout(
            iterator,
            options.timeoutMs,
            timeoutMessage,
            signal,
          )

          if (nextResult.done) {
            throw new Error(
              `Execution update stream ended before ${options.executionLabel} finished: ${executionId}`,
            )
          }

          const execution = nextResult.value
          const now = Date.now()

          if (execution.id !== executionId) {
            if (now - lastEventTime > options.timeoutMs) {
              throw new Error(timeoutMessage)
            }
            continue
          }

          lastEventTime = now

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

          if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
            if (hasPendingLine) {
              process.stdout.write("\n")
            }
            return execution
          }

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
