import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Data, DateTime, Effect, Option, Schema } from "effect"
import {
  type AttemptPolicy,
  type InvalidAttemptPolicy,
  readAttemptPolicy,
} from "./attempt-lifecycle"
import {
  type InvalidQueueObservationPolicy,
  type QueueObservation,
  readQueueObservationPolicy,
} from "./queue-health"
import { WorkerMessage } from "./worker-protocol"

export class WorkerSupervisionError extends Data.TaggedError(
  "WorkerSupervisionError",
)<{
  readonly message: string
}> {}

interface SupervisorOptions {
  readonly command: readonly [string, ...string[]]
  readonly stateFile?: string
  readonly env?: NodeJS.ProcessEnv
  readonly observe?: (
    publish: (observation: QueueObservation) => void,
  ) => Effect.Effect<never, unknown>
}

// The OS boundary uses native monotonic time and timers in a different process
// from user code. No child heartbeat can extend an attempt's hard deadline.
export const superviseWorker = (
  options: SupervisorOptions,
): Effect.Effect<
  never,
  InvalidAttemptPolicy | InvalidQueueObservationPolicy | WorkerSupervisionError
> =>
  Effect.gen(function* () {
    let restarts = 0
    let state: Record<string, unknown> = {}
    let queueObservation: QueueObservation | undefined
    let longestAttempt: Extract<WorkerMessage, { kind: "attempt" }> | undefined
    let publishedHealth = "starting"
    let publishedDetail: string | undefined
    const publish = (health: string, detail?: string) => {
      publishedHealth = health
      publishedDetail = detail
      const path = options.stateFile
      if (!path) return
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        `${path}.supervisor-tmp`,
        `${JSON.stringify({
          ...state,
          queueObservation,
          longestAttempt,
          // A state message can carry escalation before the generation observer
          // resumes. Never advertise that already-known recovery as healthy.
          health:
            health === "ready" && state["escalation"] !== undefined
              ? "recovering"
              : health,
          restarts,
          detail,
          supervisorPid: process.pid,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now())),
        })}\n`,
      )
      renameSync(`${path}.supervisor-tmp`, path)
    }
    const policy = yield* readAttemptPolicy(
      {},
      { ...process.env, ...options.env },
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => publish("failed", error.message)),
      ),
    )
    yield* readQueueObservationPolicy({ ...process.env, ...options.env }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => publish("failed", error.message)),
      ),
    )
    if (options.observe)
      yield* Effect.forkChild(
        options.observe((observation) => {
          queueObservation = observation
          publish(publishedHealth, publishedDetail)
        }),
      )
    while (true) {
      const reason = yield* Effect.callback<string, WorkerSupervisionError>(
        (resume, signal) => {
          const finished = runGeneration(
            options,
            policy,
            signal,
            (message) => {
              if (message.kind === "attempt") longestAttempt = message
              if (message.kind === "idle" || message.kind === "starting")
                longestAttempt = undefined
              if (message.kind === "starting") state = {}
              if (message.kind === "ready")
                state = { workerPid: message.pid, instance: message.instance }
              if (message.kind === "state")
                state = { ...state, ...message.state }
              publish(message.kind === "starting" ? "starting" : "ready")
            },
            publish,
          )
          finished.then(
            (reason) => resume(Effect.succeed(reason)),
            (cause: unknown) =>
              resume(
                Effect.fail(
                  new WorkerSupervisionError({ message: String(cause) }),
                ),
              ),
          )
          // Interruption aborts the OS observer and waits for its kill/reap finally
          // block. Shutdown cannot leave a live worker behind the completed fiber.
          return Effect.promise(() =>
            finished.then(
              () => {},
              () => {},
            ),
          )
        },
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => publish("failed", error.message)),
        ),
      )
      restarts += 1
      publish("recovering", reason)
      yield* Effect.logWarning(
        "Local queue worker stopped; restarting for durable lease recovery",
        {
          reason,
          restarts,
          outcome: "unknown",
          idempotencyRequired: true,
        },
      )
      // Avoid a tight crash loop. A replacement that cannot become ready fails
      // visibly rather than repeatedly presenting an idle/healthy worker.
      yield* Effect.sleep(100)
    }
  })

const runGeneration = async (
  options: SupervisorOptions,
  policy: AttemptPolicy,
  signal: AbortSignal,
  onMessage: (message: WorkerMessage) => void,
  publish: (health: string, detail?: string) => void,
): Promise<string> => {
  publish("starting")
  const [executable, ...args] = options.command
  const child = spawn(executable, args, {
    env: { ...process.env, ...options.env, PF_LOCAL_QUEUE_STATE_FILE: "" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // bun --watch has a watcher process. Kill its whole isolated process group,
    // not only the watcher, before any replacement can acquire a claim.
    detached: true,
    serialization: "json",
  })
  let exited = false
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true
      resolve()
    }),
  )
  let ready = false
  let deadline = performance.now() + 60_000
  let heartbeat = performance.now()
  let active = false
  let claim = "startup"
  let lastHealth = performance.now()
  const decode = Schema.decodeUnknownOption(WorkerMessage)
  let timer: ReturnType<typeof setInterval> | undefined
  let abort: () => void = () => {}
  try {
    const reason = await new Promise<string>((resolve, reject) => {
      abort = () => reject(new Error("Supervisor stopping"))
      signal.addEventListener("abort", abort, { once: true })
      child.once("error", reject)
      child.once("exit", (code, terminationSignal) => {
        if (!ready)
          reject(
            new Error(
              `Worker exited before readiness (${code ?? terminationSignal})`,
            ),
          )
        else resolve(`Worker exited (${code ?? terminationSignal}); ${claim}`)
      })
      child.on("message", (input: unknown) => {
        const decoded = decode(input)
        if (Option.isNone(decoded)) {
          reject(new Error("Invalid worker supervision message"))
          return
        }
        const message = decoded.value
        const now = performance.now()
        heartbeat = now
        switch (message.kind) {
          case "starting":
            ready = false
            active = false
            deadline = now + 60_000
            claim = "startup"
            break
          case "heartbeat":
            return
          case "ready":
            ready = true
            active = false
            deadline = Infinity
            claim = "idle"
            break
          case "claim":
            active = true
            deadline = now + policy.queueIoMs + policy.cancellationGraceMs
            claim = "claim outcome unknown"
            break
          case "attempt":
            active = true
            deadline =
              now +
              policy.executionMs +
              3 * policy.cancellationGraceMs +
              policy.queueIoMs
            claim = `job=${message.jobId} receipt=${message.receipt} outcome=unknown`
            break
          case "idle":
            active = false
            deadline = Infinity
            claim = "idle"
            break
          case "state":
            if (message.state.escalation !== undefined)
              resolve(
                `Attempt escalated: ${JSON.stringify(message.state.escalation)}`,
              )
            break
        }
        if (
          message.kind === "starting" ||
          message.kind === "attempt" ||
          message.kind === "idle" ||
          message.kind === "ready" ||
          message.kind === "state"
        ) {
          try {
            onMessage(message)
          } catch (error) {
            reject(error)
          }
        }
      })
      timer = setInterval(() => {
        const now = performance.now()
        if (ready && now - lastHealth >= 1000) {
          lastHealth = now
          try {
            publish(
              now - heartbeat > policy.queueIoMs + policy.cancellationGraceMs
                ? "unresponsive"
                : "ready",
              claim,
            )
          } catch (error) {
            reject(error)
          }
        }
        if (
          now >= deadline ||
          (ready &&
            !active &&
            now - heartbeat > policy.queueIoMs + policy.cancellationGraceMs)
        ) {
          if (!ready) reject(new Error("Worker readiness timed out"))
          else resolve(`Worker recovery bound exceeded; ${claim}`)
        }
      }, 50)
      if (signal.aborted) abort()
    })
    publish("recovering", reason)
    return reason
  } finally {
    if (timer) clearInterval(timer)
    child.removeAllListeners("message")
    signal.removeEventListener("abort", abort)
    // No detached user execution, finalizer or native busy wait can veto SIGKILL.
    // Reap before restart. If the host cannot reap within grace, fail closed.
    killGroup(child)
    if (!exited && child.pid !== undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exit,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error("Worker could not be reaped; refusing replacement"),
                ),
              policy.cancellationGraceMs,
            )
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }
    if (signal.aborted) publish("stopped")
  }
}

const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error
  }
}
