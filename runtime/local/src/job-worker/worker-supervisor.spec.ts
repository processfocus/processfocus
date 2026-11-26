import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Fiber, Result, Schema } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import {
  createSupervisedQueueTable,
  supervisedQueueLayer,
} from "../test-support/supervised-queue"
import { observeQueueHealth } from "./queue-health"
import { superviseWorker } from "./worker-supervisor"
import { expect, it } from "bun:test"

const Event = Schema.Struct({
  name: Schema.String,
  attempt: Schema.Number,
  receipt: Schema.String,
  pid: Schema.Number,
})
const State = Schema.Struct({
  health: Schema.String,
  restarts: Schema.Number,
  detail: Schema.optional(Schema.String),
  activeJobs: Schema.optional(Schema.Number),
  paused: Schema.optional(Schema.Boolean),
  workerPid: Schema.optional(Schema.Number),
  instance: Schema.optional(Schema.String),
  queueObservation: Schema.optional(
    Schema.Struct({
      status: Schema.Literal("available"),
      sampledAt: Schema.String,
      queues: Schema.Array(
        Schema.Struct({
          queue: Schema.String,
          eligible: Schema.Number,
          processing: Schema.Number,
          terminal: Schema.Number,
          oldestEligible: Schema.NullOr(
            Schema.Struct({ jobId: Schema.String, waitingMs: Schema.Number }),
          ),
        }),
      ),
    }),
  ),
  longestAttempt: Schema.optional(
    Schema.Struct({
      jobId: Schema.String,
      receipt: Schema.String,
      queue: Schema.String,
      startedAt: Schema.String,
      executionDeadline: Schema.String,
    }),
  ),
})
const waitFor = async (condition: () => Promise<boolean>, timeout = 15_000) => {
  const until = performance.now() + timeout
  while (performance.now() < until) {
    if (await condition()) return
    await Bun.sleep(50)
  }
  throw new Error("Supervised persistent queue did not recover within bound")
}

it("preserves Bun source-watch reload and reaps the live worker on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-watch-"))
  const path = join(directory, "pf.db")
  const stateFile = join(directory, "state.json")
  const entry = join(directory, "entry.ts")
  const source = `import ${JSON.stringify(join(import.meta.dir, "../test-fixtures/supervised-queue-worker.ts"))}\n`
  let fiber: Fiber.Fiber<void, unknown> | undefined
  try {
    await Effect.runPromise(
      createSupervisedQueueTable.pipe(
        Effect.provide(supervisedQueueLayer(path)),
      ),
    )
    await writeFile(entry, source)
    fiber = Effect.runFork(
      superviseWorker({
        command: [process.execPath, "--watch", entry, path],
        stateFile,
      }),
    )
    const state = async () =>
      Schema.decodeUnknownSync(State)(
        JSON.parse(await readFile(stateFile, "utf8")),
      )
    await waitFor(async () => {
      try {
        return (await state()).workerPid !== undefined
      } catch {
        return false
      }
    })
    const before = (await state()).instance!
    await writeFile(entry, `${source}// source saved\n`)
    await waitFor(async () => {
      const current = await state()
      return current.instance !== undefined && current.instance !== before
    })
    const after = (await state()).workerPid!
    expect((await state()).instance).not.toBe(before)
    expect((await state()).health).toBe("ready")
    await Effect.runPromise(Fiber.interrupt(fiber))
    fiber = undefined
    expect(() => process.kill(after, 0)).toThrow()
    expect((await state()).health).toBe("stopped")
  } finally {
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
    await rm(directory, { force: true, recursive: true })
  }
}, 30_000)

it("reports failed readiness instead of a healthy idle worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-startup-failure-"))
  const stateFile = join(directory, "state.json")
  try {
    const result = await Effect.runPromise(
      Effect.result(
        superviseWorker({
          command: [process.execPath, "-e", "process.exit(23)"],
          stateFile,
        }),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    const state = Schema.decodeUnknownSync(State)(
      JSON.parse(await readFile(stateFile, "utf8")),
    )
    expect(state.health).toBe("failed")
    expect(state.detail).toContain("before readiness")
    expect(state.restarts).toBe(0)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

// Strongest boundary: real isolated Bun execution (not simulated permit release),
// real Turso WAL, claim receipts and durable terminal evidence across SIGKILL.
// Existing fiber tests cannot execute a blocking handler without blocking tests.
for (const scenario of ["non-cooperative", "blocking", "cleanup", "ack"]) {
  it(`recovers persistent capacity after ${scenario}, preserving pause, attempts and terminal evidence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "queue-supervision-"))
    const path = join(directory, "pf.db")
    const stateFile = join(directory, "state.json")
    const pauseFile = join(directory, "pause")
    const layer = supervisedQueueLayer(path)
    const readRows = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          return yield* db.select().from(schema.jobQueue)
        }).pipe(Effect.provide(layer)),
      )
    const readEvents = async () => {
      try {
        return (await readFile(`${path}.events`, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => Schema.decodeUnknownSync(Event)(JSON.parse(line)))
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return []
        throw error
      }
    }
    const readState = async () =>
      Schema.decodeUnknownSync(State)(
        JSON.parse(await readFile(stateFile, "utf8")),
      )
    // Non-cooperative case has budget to retry; the other cases abandon their
    // final attempt and must be retired by startup/periodic maintenance instead.
    const maxAttempts = scenario === "non-cooperative" ? 2 : 1
    let fiber: Fiber.Fiber<void, unknown> | undefined
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* createSupervisedQueueTable
          const db = yield* TypedSqliteDrizzle
          yield* db.insert(schema.jobQueue).values([
            {
              id: "good",
              queue: "work",
              jobPayload: { name: "good" },
              availableAt: DateTime.makeUnsafe(1),
            },
            {
              id: "bad",
              queue: "work",
              jobPayload: { name: "bad" },
              availableAt: DateTime.makeUnsafe(2),
              jobRetryLimit: maxAttempts,
            },
          ])
        }).pipe(Effect.provide(layer)),
      )
      await writeFile(pauseFile, "operator-pause")
      fiber = Effect.runFork(
        superviseWorker({
          observe: (publish) =>
            observeQueueHealth(publish, {
              PF_LOCAL_QUEUE_SAMPLE_MS: "50",
            }).pipe(Effect.provide(layer)),
          command: [
            process.execPath,
            ...(scenario === "blocking" ? ["--watch"] : []),
            join(
              import.meta.dir,
              "../test-fixtures/supervised-queue-worker.ts",
            ),
            path,
          ],
          stateFile,
          env: {
            QUEUE_SCENARIO: scenario,
            PF_LOCAL_QUEUE_EXECUTION_MS: "700",
            PF_LOCAL_QUEUE_CANCELLATION_GRACE_MS: "300",
            PF_LOCAL_QUEUE_IO_MS: "400",
            PF_LOCAL_QUEUE_VISIBILITY_MS: "1500",
            PF_LOCAL_QUEUE_PAUSE_FILE: pauseFile,
          },
        }),
      )
      await waitFor(async () => {
        try {
          const state = await readState()
          return state.health === "ready" && state.paused === true
        } catch {
          return false
        }
      })
      await Bun.sleep(200)
      expect(await readEvents()).toEqual([])
      await unlink(pauseFile)
      await waitFor(async () => (await readEvents()).length > 0)
      await writeFile(pauseFile, "pause-survives-replacement")
      if (scenario === "blocking") {
        await waitFor(
          async () =>
            (await readState()).queueObservation?.queues[0]?.processing === 1,
        )
        const before = (await readState()).queueObservation!
        expect(before.queues[0]?.oldestEligible?.jobId).toBe("good")
        expect((await readState()).longestAttempt).toMatchObject({
          jobId: "bad",
          queue: "work",
        })
        // Parent maintenance must progress even though the execution thread
        // cannot run a single timer, heartbeat, sweep or observation fiber.
        await Effect.runPromise(
          Effect.gen(function* () {
            const db = yield* TypedSqliteDrizzle
            yield* db.insert(schema.jobQueue).values({
              id: "abandoned",
              queue: "separate",
              jobPayload: {},
              availableAt: DateTime.makeUnsafe(0),
              jobAttempts: 1,
              jobRetryLimit: 1,
            })
          }).pipe(Effect.provide(layer)),
        )
        await waitFor(async () => (await readState()).health === "unresponsive")
        const blocked = await readState()
        expect(blocked.queueObservation?.sampledAt).not.toBe(before.sampledAt)
        expect(
          blocked.queueObservation?.queues.find((q) => q.queue === "work")
            ?.oldestEligible?.waitingMs,
        ).toBeGreaterThan(before.queues[0]!.oldestEligible!.waitingMs)
        await waitFor(async () => {
          const state = await readState()
          return (
            state.restarts === 0 &&
            state.queueObservation?.queues.some(
              (q) => q.queue === "separate" && q.terminal === 1,
            ) === true
          )
        })
      }
      await waitFor(async () => {
        const state = await readState()
        return (
          state.restarts >= 1 &&
          state.health === "ready" &&
          state.paused === true
        )
      })
      expect((await readEvents()).map((event) => event.name)).toEqual(["bad"])
      const recoveredRows = await readRows()
      expect(recoveredRows.find((row) => row.id === "good")?.jobAttempts).toBe(
        0,
      )
      expect(recoveredRows.find((row) => row.id === "bad")?.jobAttempts).toBe(1)
      await unlink(pauseFile)
      await waitFor(async () =>
        (await readEvents()).some((event) => event.name === "good"),
      )
      await waitFor(async () => {
        const rows = await readRows()
        return (
          !rows.some((row) => row.id === "good") &&
          (maxAttempts === 2
            ? rows.length === 0
            : rows.find((row) => row.id === "bad")?.terminalOutcome ===
              "unknown")
        )
      })
      const events = await readEvents()
      expect(events[0]?.name).toBe("bad") // actual newest-first dispatch
      expect((await readState()).restarts).toBeGreaterThanOrEqual(1)
      const bad = events.filter((event) => event.name === "bad")
      if (maxAttempts === 2) {
        expect(bad.map((event) => event.attempt)).toEqual([1, 2])
        expect(bad[0]?.receipt).not.toBe(bad[1]?.receipt)
        expect(bad[0]?.pid).not.toBe(bad[1]?.pid)
      } else {
        expect(bad).toHaveLength(1)
        const terminal = (await readRows()).find((row) => row.id === "bad")
        expect(terminal?.jobAttempts).toBe(1)
        expect(terminal?.terminalAt).not.toBeNull()
        expect(terminal?.terminalReason).toBeTruthy()
      }
      // The parent returned only after stopping/reaping the old execution.
      expect(() => process.kill(events[0]!.pid, 0)).toThrow()
    } catch (error) {
      throw new Error(
        `${String(error)}; state=${JSON.stringify(await readState())}; rows=${JSON.stringify(await readRows())}; events=${JSON.stringify(await readEvents())}`,
      )
    } finally {
      if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
}
