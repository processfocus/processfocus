import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  DEFAULT_VISIBILITY_TIMEOUT,
  QueueService,
  type RawJob,
  Runtime,
  makeJobDispatcher,
} from "@processfocus/runtime"
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import type { Duration } from "effect"
import {
  Cause,
  Duration as D,
  DateTime,
  Effect,
  FiberRef,
  Metric,
  Option,
  Random,
  Ref,
  Schedule,
} from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { ScheduledFlowNotFoundError } from "@pf/job-handler"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import type { JobHandlerMap } from "./types"

/**
 * Sleep for a duration with small symmetric jitter.
 */
const sleepWithJitter = (
  base: Duration.Duration,
  maxJitter: Duration.Duration,
) =>
  Effect.gen(function* () {
    const baseMs = D.toMillis(base)
    const maxJitterMs = D.toMillis(maxJitter)
    const jitterMs = Math.round(((yield* Random.next) * 2 - 1) * maxJitterMs)
    const jitteredMs = Math.max(0, baseMs + jitterMs)
    yield* Effect.sleep(D.millis(jitteredMs))
  })

const MAX_POLL_JITTER = D.millis(100)
const MAX_SUCCESS_DELAY_JITTER = D.millis(50)
const PAUSED_POLL_DELAY = D.millis(100)
const MAX_PAUSED_POLL_JITTER = D.millis(25)
const SQLITE_BUSY_RETRY_SCHEDULE = Schedule.addDelay(Schedule.recurs(4), () =>
  D.millis(50),
)

export interface LocalQueueWorkerState {
  readonly activeJobs: number
  readonly paused: boolean
  readonly pauseToken: string | null
  readonly updatedAt: string
}

interface QueuePollerOptions {
  readonly onWorkerStateChange?: (
    state: LocalQueueWorkerState,
  ) => Effect.Effect<void>
  readonly readPauseToken?: () => string | null
}

const getLocalQueueSuccessDelay = () => {
  const configuredDelayMs = process.env["PF_LOCAL_QUEUE_SUCCESS_DELAY_MS"]
  if (!configuredDelayMs) {
    return Option.none<Duration.Duration>()
  }

  const delayMs = Number.parseInt(configuredDelayMs, 10)
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Option.none<Duration.Duration>()
  }

  return Option.some(D.millis(delayMs))
}

const getLocalQueuePauseFile = () => process.env["PF_LOCAL_QUEUE_PAUSE_FILE"]

const getLocalQueueStateFile = () => process.env["PF_LOCAL_QUEUE_STATE_FILE"]

const readLocalQueuePauseToken = (): string | null => {
  const pauseFile = getLocalQueuePauseFile()
  if (pauseFile === undefined || pauseFile.length === 0) {
    return null
  }

  try {
    return existsSync(pauseFile) ? readFileSync(pauseFile, "utf8").trim() : null
  } catch {
    return null
  }
}

const writeLocalQueueWorkerState = (state: LocalQueueWorkerState) =>
  Effect.try({
    try: () => {
      const stateFile = getLocalQueueStateFile()
      if (stateFile === undefined || stateFile.length === 0) {
        return true
      }

      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify(state)}\n`, "utf8")
      return true
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning("Failed to write local queue worker state", {
        error: String(error),
      }).pipe(Effect.as(false)),
    ),
  )

const isSqliteBusy = (error: unknown): boolean => {
  let current: unknown = error

  while (current != null) {
    if (current instanceof Error) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current = current.cause
      continue
    }

    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current = "cause" in current ? current.cause : undefined
      continue
    }

    if (
      typeof current === "string" &&
      (current.includes("SQLITE_BUSY") ||
        current.includes("database is locked") ||
        current.includes("SQL statements in progress"))
    ) {
      return true
    }

    break
  }

  return false
}

const retrySqliteBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: SQLITE_BUSY_RETRY_SCHEDULE,
      while: isSqliteBusy,
    }),
  )

const IDLE_POLL_SCHEDULE = [
  {
    maxIdleMs: D.toMillis(D.seconds(30)),
    delay: D.millis(500),
    label: "500ms",
  },
  {
    maxIdleMs: D.toMillis(D.minutes(1)),
    delay: D.seconds(1),
    label: "1s",
  },
  {
    maxIdleMs: D.toMillis(D.minutes(2)),
    delay: D.seconds(2),
    label: "2s",
  },
  {
    maxIdleMs: Number.POSITIVE_INFINITY,
    delay: D.seconds(3),
    label: "3s",
  },
] as const

type IdlePollStage = (typeof IDLE_POLL_SCHEDULE)[number]

const LAST_IDLE_POLL_STAGE: IdlePollStage = IDLE_POLL_SCHEDULE.at(-1) ?? {
  maxIdleMs: Number.POSITIVE_INFINITY,
  delay: D.seconds(3),
  label: "3s",
}

const MAX_IDLE_STAGE_START_MS = IDLE_POLL_SCHEDULE.at(-2)?.maxIdleMs ?? 0

const ERROR_POLL_SCHEDULE = [
  D.millis(250),
  D.millis(500),
  D.seconds(1),
] as const

const LAST_ERROR_POLL_DELAY = ERROR_POLL_SCHEDULE.at(-1) ?? D.seconds(1)

export const getIdlePollStage = (idleFor: Duration.Duration): IdlePollStage => {
  const idleMs = D.toMillis(idleFor)
  return (
    IDLE_POLL_SCHEDULE.find((stage) => idleMs < stage.maxIdleMs) ??
    LAST_IDLE_POLL_STAGE
  )
}

export const getPollErrorDelay = (consecutiveErrors: number) => {
  const index = Math.min(
    Math.max(consecutiveErrors - 1, 0),
    ERROR_POLL_SCHEDULE.length - 1,
  )
  return ERROR_POLL_SCHEDULE[index] ?? LAST_ERROR_POLL_DELAY
}

// Metrics for job processing
const jobsProcessed = Metric.counter("jobs.processed", {
  description: "Number of jobs processed",
})

const jobsFailed = Metric.counter("jobs.failed", {
  description: "Number of jobs that failed",
})

/**
 * Claim the globally next available job across all local runtime queues.
 *
 * Ordering keeps fresh jobs ahead of retries, then prefers the most recently
 * available jobs so new local work is not stuck behind older jobs with the
 * same attempt count.
 */
export const claimNextLocalJob = (queueNames: readonly string[]) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const now = yield* DateTime.now
    const lockedUntil = DateTime.add(now, {
      millis: D.toMillis(DEFAULT_VISIBILITY_TIMEOUT),
    })
    const receipt = randomUUID()
    const claimOrder = [
      schema.jobQueue.jobAttempts,
      // Local dev prefers the newest ready work ahead of older retries so
      // fresh UI-triggered events are not stuck behind stale backlog.
      desc(schema.jobQueue.availableAt),
      desc(schema.jobQueue.id),
    ]

    const availableJobConditions = and(
      inArray(schema.jobQueue.queue, queueNames),
      lte(schema.jobQueue.availableAt, now),
      or(
        isNull(schema.jobQueue.lockedUntil),
        lte(schema.jobQueue.lockedUntil, now),
      ),
      lt(schema.jobQueue.jobAttempts, schema.jobQueue.jobRetryLimit),
      eq(schema.jobQueue._deleted, false),
    )

    // Avoid acquiring a SQLite writer lock when all watched queues are idle.
    const candidate = yield* db
      .select({ id: schema.jobQueue.id })
      .from(schema.jobQueue)
      .where(availableJobConditions)
      .orderBy(...claimOrder)
      .limit(1)
      .pipe(retrySqliteBusy)

    const candidateRow = candidate[0]
    if (candidateRow === undefined) {
      return Option.none()
    }

    const result = yield* db
      .update(schema.jobQueue)
      .set({
        lockedUntil,
        claimReceipt: receipt,
        jobAttempts: sql`${schema.jobQueue.jobAttempts} + 1`,
      })
      .where(
        and(eq(schema.jobQueue.id, candidateRow.id), availableJobConditions),
      )
      .returning({
        id: schema.jobQueue.id,
        queue: schema.jobQueue.queue,
        jobPayload: schema.jobQueue.jobPayload,
        jobAttempts: schema.jobQueue.jobAttempts,
        jobRetryLimit: schema.jobQueue.jobRetryLimit,
        availableAt: schema.jobQueue.availableAt,
        lockedUntil: schema.jobQueue.lockedUntil,
      })
      .pipe(retrySqliteBusy)

    const row = result[0]
    if (!row) {
      // Another poller may win between the read and update; the next poll will
      // observe any remaining ready jobs.
      return Option.none()
    }

    return Option.some<RawJob>({
      jobId: row.id,
      receipt,
      queue: row.queue,
      payload: row.jobPayload,
      attempts: row.jobAttempts,
      maxAttempts: row.jobRetryLimit,
      availableAt: row.availableAt,
      lockedUntil,
    })
  })

export const processClaimedJob = <E, R>(
  job: RawJob,
  queueHandlers: JobHandlerMap<E, R>,
) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    const requestTimeFiberRef = yield* RequestTime
    const now = yield* DateTime.now
    yield* FiberRef.set(requestTimeFiberRef, now)
    yield* Effect.log(`Processing job ${job.jobId} (attempt ${job.attempts})`)

    const dispatcher = makeJobDispatcher<E, R, JobHandlerMap<E, R>>(
      queueHandlers,
    )
    const result = yield* Runtime.job(dispatcher, job)
    if (result.kind === "acknowledge") {
      yield* queueService.acknowledge(job.jobId, job.receipt).pipe(
        Effect.tapErrorCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause)
            yield* Effect.logError(
              `Job ${job.jobId} acknowledgement failed: ${message}`,
            )
            yield* Effect.annotateCurrentSpan("job.failed", true)
            yield* Effect.annotateCurrentSpan("job.error", message)
            yield* Metric.increment(jobsFailed)
          }),
        ),
        Effect.withSpan(`job.acknowledge.${job.queue}`, {
          attributes: {
            "job.id": job.jobId,
            "job.queue": job.queue,
            "job.attempts": job.attempts,
          },
        }),
      )
      yield* Metric.increment(jobsProcessed)
      return
    }

    const failure = Cause.failureOption(result.cause)
    if (Cause.isInterruptedOnly(result.cause)) {
      return yield* Effect.interrupt
    }
    if (
      Option.isSome(failure) &&
      failure.value instanceof ScheduledFlowNotFoundError
    ) {
      yield* Effect.logInfo(
        `Job ${job.jobId} will retry: scheduled flow not yet visible`,
        {
          scheduledFlowId: failure.value.scheduledFlowId,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
        },
      )
      return
    }

    yield* Effect.logError(
      `Job ${job.jobId} failed: ${Cause.pretty(result.cause)}`,
    )
    yield* Metric.increment(jobsFailed)
    if (result.kind === "terminal") {
      yield* queueService.fail(job.jobId, job.receipt, { retryable: false })
    } else if (Option.isSome(failure)) {
      yield* queueService.fail(job.jobId, job.receipt, {
        releaseImmediately: false,
      })
    }
  })

/**
 * Creates a single queue poller that claims from all local runtime queues.
 *
 * The poller:
 * 1. Acquires a permit from the global semaphore
 * 2. Claims the globally next available job across all watched queues
 * 3. If a job is found, forks a child fiber to process it while keeping the permit
 * 4. The child fiber releases the permit when processing finishes
 * 5. If no job was found, releases the permit and sleeps
 * 6. Repeats forever
 *
 * Claiming still happens under the semaphore so we never build up more claimed
 * jobs than we can process concurrently.
 *
 * @param queueHandlers - Queue handler registry keyed by queue name
 * @param globalSemaphore - Shared semaphore to limit concurrent job processing
 */
export const createSingleQueuePoller = <E, R>(
  queueHandlers: JobHandlerMap<E, R>,
  globalSemaphore: Effect.Semaphore,
  options: QueuePollerOptions = {},
) => {
  const queueNames = Object.keys(queueHandlers)
  const successDelay = getLocalQueueSuccessDelay()
  const notifyWorkerState = options.onWorkerStateChange ?? (() => Effect.void)
  const readPauseToken = options.readPauseToken ?? readLocalQueuePauseToken
  const waitAfterSuccessfulJob = Option.match(successDelay, {
    onNone: () => Effect.void,
    onSome: (delay) => sleepWithJitter(delay, MAX_SUCCESS_DELAY_JITTER),
  })

  return Effect.gen(function* () {
    let idleSinceMs: number | null = null
    let lastIdleStageLabel: string | null = null
    let consecutivePollErrors = 0
    let hasClaimedSinceStartup = false
    let lastPauseState = false
    let lastWorkerStateSnapshot: string | null = null
    const activeJobsRef = yield* Ref.make(0)

    const writeState = (paused: boolean, pauseToken: string | null) =>
      Effect.gen(function* () {
        const activeJobs = yield* Ref.get(activeJobsRef)
        const snapshot = `${activeJobs}:${paused}:${pauseToken ?? ""}`
        if (snapshot === lastWorkerStateSnapshot) {
          return
        }

        const now = yield* DateTime.now
        const workerState = {
          activeJobs,
          paused,
          pauseToken,
          updatedAt: DateTime.formatIso(now),
        }
        const written = yield* writeLocalQueueWorkerState(workerState)
        yield* notifyWorkerState(workerState)
        if (written) {
          lastWorkerStateSnapshot = snapshot
        }
      })
    const waitWithPauseToken = (pauseToken: string) =>
      Effect.gen(function* () {
        if (!lastPauseState) {
          lastPauseState = true
          yield* Effect.logDebug("Local queue poller paused by pause file")
        }

        yield* writeState(true, pauseToken)
        yield* sleepWithJitter(PAUSED_POLL_DELAY, MAX_PAUSED_POLL_JITTER)
      })

    const waitIfPaused = Effect.gen(function* () {
      const pauseToken = readPauseToken()
      if (pauseToken === null) {
        if (lastPauseState) {
          lastPauseState = false
          yield* Effect.logDebug("Local queue poller resumed")
          yield* writeState(false, null)
        }
        return false
      }

      yield* waitWithPauseToken(pauseToken)
      return true
    })

    return yield* Effect.forever(
      Effect.gen(function* () {
        if (yield* waitIfPaused) {
          return
        }

        yield* globalSemaphore.take(1)
        const releasePermit = globalSemaphore.release(1)

        const pauseToken = readPauseToken()
        if (pauseToken !== null) {
          yield* releasePermit
          yield* waitWithPauseToken(pauseToken)
          return
        }

        const jobOption = yield* claimNextLocalJob(queueNames).pipe(
          Effect.withTracerEnabled(false),
          Effect.tapErrorCause(() => releasePermit),
          Effect.tap((jobOption) =>
            Option.isNone(jobOption) ? releasePermit : Effect.void,
          ),
        )

        if (Option.isNone(jobOption)) {
          // A successful poll roundtrip, even with no ready jobs, clears the
          // transient error streak used for poll-failure backoff.
          consecutivePollErrors = 0
          const now = yield* DateTime.now
          const nowMs = DateTime.toEpochMillis(now)
          idleSinceMs ??= hasClaimedSinceStartup
            ? nowMs
            : nowMs - MAX_IDLE_STAGE_START_MS
          const idleStage = getIdlePollStage(D.millis(nowMs - idleSinceMs))

          if (idleStage.label !== lastIdleStageLabel) {
            lastIdleStageLabel = idleStage.label
            yield* Effect.logDebug(
              `Local queue poller idle backoff now ${idleStage.label}`,
            )
          }

          yield* sleepWithJitter(idleStage.delay, MAX_POLL_JITTER)
          return
        }

        idleSinceMs = null
        lastIdleStageLabel = null
        consecutivePollErrors = 0
        hasClaimedSinceStartup = true

        const job = jobOption.value
        yield* Effect.logDebug(`Processing job ${job.jobId} from ${job.queue}`)
        yield* Ref.update(activeJobsRef, (count) => count + 1)
        yield* writeState(false, null)

        const releaseJobPermit = Effect.gen(function* () {
          yield* Ref.update(activeJobsRef, (count) => Math.max(0, count - 1))
          const pauseToken = readPauseToken()
          yield* writeState(pauseToken !== null, pauseToken)
          yield* releasePermit
        })

        yield* Effect.fork(
          processClaimedJob(job, queueHandlers).pipe(
            Effect.tap(() => waitAfterSuccessfulJob),
            Effect.catchAllCause((cause) =>
              Effect.logError(`Job processing failed for ${job.jobId}`, cause),
            ),
            Effect.ensuring(releaseJobPermit),
          ),
        )
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            consecutivePollErrors += 1
            const errorDelay = getPollErrorDelay(consecutivePollErrors)
            yield* Effect.logError("Failed to poll local queues", cause)
            yield* sleepWithJitter(errorDelay, MAX_POLL_JITTER)
          }),
        ),
      ),
    )
  })
}
