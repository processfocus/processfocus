import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { sleep } from "./sleep"

interface WorkerState {
  readonly activeJobs: number
  readonly paused: boolean
  readonly pauseToken: string | null
}

const WORKER_PAUSE_TIMEOUT_MS = 15_000
const WORKER_PAUSE_POLL_MS = 100

// Process-global because one Cucumber process coordinates one local worker.
// Tests that set the pause env vars must wait for paused operations to finish
// before restoring env. Reference counting keeps overlapping foreground writes
// from resuming the worker until the last paused operation completes.
let activePauseCount = 0
let activeResume: (() => Promise<void>) | null = null
let pauseMutex: Promise<void> = Promise.resolve()

const withPauseMutex = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = pauseMutex
  let release = () => {}
  pauseMutex = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

const readWorkerState = async (
  stateFile: string,
): Promise<WorkerState | null> => {
  try {
    const raw = await readFile(stateFile, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("activeJobs" in parsed) ||
      !("paused" in parsed) ||
      !("pauseToken" in parsed) ||
      typeof parsed.activeJobs !== "number" ||
      typeof parsed.paused !== "boolean" ||
      (parsed.pauseToken !== null && typeof parsed.pauseToken !== "string")
    ) {
      return null
    }

    return {
      activeJobs: parsed.activeJobs,
      paused: parsed.paused,
      pauseToken: parsed.pauseToken,
    }
  } catch {
    // The worker may be writing the state file while we read it. Retry shortly.
    return null
  }
}

const pauseLocalWorker = async (): Promise<() => Promise<void>> => {
  const pauseFile = process.env["PF_LOCAL_QUEUE_PAUSE_FILE"]
  const stateFile = process.env["PF_LOCAL_QUEUE_STATE_FILE"]

  if (!pauseFile || !stateFile) {
    if (pauseFile || stateFile) {
      console.warn(
        "[e2e] PF_LOCAL_QUEUE_PAUSE_FILE and PF_LOCAL_QUEUE_STATE_FILE must both be set",
      )
    }
    return async () => {}
  }

  await mkdir(dirname(pauseFile), { recursive: true })
  const pauseToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`
  await writeFile(pauseFile, `${pauseToken}\n`, "utf8")

  const deadline = Date.now() + WORKER_PAUSE_TIMEOUT_MS
  let lastState: WorkerState | null = null
  while (Date.now() < deadline) {
    lastState = await readWorkerState(stateFile)
    if (
      lastState?.paused === true &&
      lastState.activeJobs === 0 &&
      lastState.pauseToken === pauseToken
    ) {
      return async () => {
        await rm(pauseFile, { force: true })
      }
    }

    await sleep(WORKER_PAUSE_POLL_MS)
  }

  await rm(pauseFile, { force: true })
  throw new Error(
    `Timed out waiting for local worker to pause. Last state: ${JSON.stringify(lastState)}`,
  )
}

const acquireLocalWorkerPause = async (): Promise<() => Promise<void>> =>
  withPauseMutex(async () => {
    if (activePauseCount === 0) {
      activeResume = await pauseLocalWorker()
    }

    activePauseCount += 1
    let released = false

    return async () => {
      if (released) {
        return
      }
      released = true

      await withPauseMutex(async () => {
        activePauseCount = Math.max(0, activePauseCount - 1)
        if (activePauseCount > 0) {
          return
        }

        const resume = activeResume
        activeResume = null
        if (resume) {
          await resume()
        }
      })
    }
  })

export const withPausedLocalWorker = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  // Higher-level auth/cleanup helpers and raw GraphQL mutations can both wrap
  // the same foreground write path. Reference counting makes that nesting safe.
  const resume = await acquireLocalWorkerPause()
  try {
    return await operation()
  } finally {
    await resume()
  }
}

export const isGraphqlMutation = (query: string): boolean =>
  // Colocated here because mutation detection only decides whether to pause the worker.
  /^\s*mutation(?:\s|\(|\{)/i.test(query)
