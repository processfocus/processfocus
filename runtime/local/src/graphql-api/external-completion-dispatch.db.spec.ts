import { QueueService } from "@processfocus/runtime"
import { Clock, DateTime, Effect, Layer } from "effect"
import { SqlClient, Statement } from "effect/sql"
import { SqlError } from "effect/sql/SqlError"
import {
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  type NewFlowDispatchJob,
  PROCESS_EVENT_QUEUE,
  TODO_EVENT_QUEUE,
} from "@pf/graphql-db-operations"
import { recoverPendingExternalCompletionEnqueues } from "@pf/process-execution/recovery"
import { makeClock } from "../test-support/clock"
import { sqliteDbCase } from "../test-support/graphql-db-matrix"
import { makeQueueLayer } from "../test-support/queue-auth-stubs"
import { describe, expect, it } from "bun:test"

const dispatchId = "step-completion:todo"
const initialTime = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
)
const layers = Layer.mergeAll(sqliteDbCase.layer, makeQueueLayer([], false))
type TestRequirements = Layer.Success<typeof layers>
interface SentJob {
  readonly queue: string
  readonly payload: unknown
  readonly logicalJobId: string | undefined
}
type SendHook = (job: SentJob) => Effect.Effect<void, SqlError>

const makeFixture = (jobCount: number) =>
  Effect.gen(function* () {
    const ops = yield* FlowExecutionOperations
    const sql = yield* SqlClient.SqlClient
    const queue = yield* QueueService
    let elapsed = 0
    const sent: SentJob[] = []
    const statements: string[] = []
    let onTimeRead: () => Effect.Effect<void, SqlError> = () => Effect.void
    const clock: Clock.Clock = {
      ...makeClock(),
      currentTimeMillis: Effect.gen(function* () {
        yield* onTimeRead()
        return initialTime + elapsed
      }).pipe(Effect.orDie),
      currentTimeMillisUnsafe: () => initialTime + elapsed,
    }

    // Count actual row mutations, not mocked operation calls. Audit-table
    // writes and index work are deliberately excluded from this local proxy.
    yield* sql`CREATE TEMP TABLE dispatch_writes (operation TEXT NOT NULL)`
    yield* sql`CREATE TEMP TRIGGER dispatch_insert AFTER INSERT ON pf_job_queue
      BEGIN INSERT INTO dispatch_writes VALUES ('insert'); END`
    yield* sql`CREATE TEMP TRIGGER dispatch_update AFTER UPDATE ON pf_job_queue
      BEGIN INSERT INTO dispatch_writes VALUES ('update'); END`
    yield* sql`CREATE TEMP TRIGGER dispatch_delete AFTER DELETE ON pf_job_queue
      BEGIN INSERT INTO dispatch_writes VALUES ('delete'); END`

    const jobs: readonly NewFlowDispatchJob[] = [
      { queue: TODO_EVENT_QUEUE, payload: { todoIds: ["todo"] } },
      ...(jobCount === 4
        ? [{ queue: PROCESS_EVENT_QUEUE, payload: { processId: "process" } }]
        : []),
      { queue: EXECUTION_EVENT_QUEUE, payload: { executionId: "execution" } },
      { queue: FLOW_EXECUTION_QUEUE, payload: { scheduledFlowId: "flow" } },
    ].map((job, sequence) => ({
      ...job,
      sourceScheduledFlowId: dispatchId,
      storageQueue: "internal-completion-outbox",
      logicalJobId:
        job.queue === FLOW_EXECUTION_QUEUE
          ? "flow-execution:flow"
          : `${job.queue}:completion:todo`,
      retryLimit: null,
      scheduledAt: null,
      sequence,
    }))
    yield* ops.insertFlowDispatchJobs(jobs)

    const drain = (onSend: SendHook = () => Effect.void) =>
      recoverPendingExternalCompletionEnqueues.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            const operation = statement.compile()[0].trim().split(/\s+/, 1)[0]
            if (operation) statements.push(operation.toLowerCase())
            return statement
          }),
        ),
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(QueueService, {
          ...queue,
          enqueue: (name, payload, options) =>
            Effect.gen(function* () {
              const job = {
                queue: name,
                payload,
                logicalJobId: options?.logicalJobId,
              }
              yield* onSend(job).pipe(Effect.orDie)
              sent.push(job)
              return `sent-${sent.length}`
            }),
        }),
      )

    return {
      ops,
      sql,
      sent,
      statements,
      jobs,
      drain,
      now: () => DateTime.makeUnsafe(initialTime + elapsed),
      advance: (milliseconds: number) => {
        elapsed += milliseconds
      },
      beforeTimeRead: (hook: typeof onTimeRead) => {
        onTimeRead = hook
      },
      writes: () =>
        sql<{ operation: string; rows: number }>`
          SELECT operation, COUNT(*) AS rows FROM dispatch_writes
          GROUP BY operation ORDER BY operation`,
      pending: () => ops.queryFlowDispatchJobs(dispatchId),
    }
  })

const runScenario = <A, E>(
  jobCount: number,
  body: (
    fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  ) => Effect.Effect<A, E, TestRequirements>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture(jobCount)
      return yield* body(fixture)
    }).pipe(Effect.provide(layers)),
  )

describe("external completion dispatch leases (real SQLite)", () => {
  it.each([3, 4])(
    "drains a fast %i-job batch without renewal writes",
    async (count) => {
      await runScenario(
        count,
        ({ drain, pending, writes, sent, jobs, statements }) =>
          Effect.gen(function* () {
            yield* drain()
            const mutations = yield* writes()
            console.info(
              `dispatch ${count}-job SQL/local rows`,
              statements,
              mutations,
            )
            expect(
              mutations.filter((row) => row.operation !== "update"),
            ).toEqual([
              { operation: "delete", rows: count },
              { operation: "insert", rows: count },
            ])
            // One initial claim; no renewal UPDATE statements. Row counts alone
            // also include the schema's updated_at trigger writes.
            expect(
              statements.filter((operation) => operation === "update"),
            ).toHaveLength(1)
            expect(yield* pending()).toEqual([])
            expect(sent.map((job) => job.logicalJobId)).toEqual(
              jobs.map((job) => job.logicalJobId),
            )
          }),
      )
    },
  )

  it("drains 16 jobs across four dispatches with one claim and one acknowledgment", async () => {
    await runScenario(4, ({ ops, jobs, drain, statements, sent }) =>
      Effect.gen(function* () {
        for (let i = 1; i < 4; i++) {
          yield* ops.insertFlowDispatchJobs(
            jobs.map((job) => ({
              ...job,
              sourceScheduledFlowId: `${dispatchId}-${i}`,
              logicalJobId: `${job.logicalJobId}-${i}`,
            })),
          )
        }
        expect(yield* drain()).toBe(4)
        expect(sent).toHaveLength(16)
        expect(
          statements.filter((operation) => operation === "update"),
        ).toHaveLength(1)
        expect(
          statements.filter((operation) => operation === "delete"),
        ).toHaveLength(1)
        for (let i = 0; i < 4; i++) {
          expect(
            yield* ops.queryFlowDispatchJobs(
              i === 0 ? dispatchId : `${dispatchId}-${i}`,
            ),
          ).toEqual([])
          expect(sent.slice(i * 4, i * 4 + 4).map((job) => job.queue)).toEqual(
            jobs.map((job) => job.queue),
          )
        }
      }),
    )
  })

  it.each([239_999, 240_000])(
    "renews only at a minute remaining (elapsed %i ms)",
    async (elapsed) => {
      await runScenario(4, ({ drain, advance, statements, sent, pending }) =>
        Effect.gen(function* () {
          const updatesAtSend: number[] = []
          yield* drain(() =>
            Effect.sync(() => {
              updatesAtSend.push(
                statements.filter((operation) => operation === "update").length,
              )
              if (sent.length === 0) advance(elapsed)
            }),
          )
          expect(updatesAtSend).toEqual(
            elapsed === 239_999 ? [1, 1, 1, 1] : [1, 2, 2, 2],
          )
          expect(sent).toHaveLength(4)
          expect(yield* pending()).toEqual([])
        }),
      )
    },
  )

  it("renews the budget during slow dispatch rather than before each send", async () => {
    await runScenario(4, ({ drain, advance, statements, sent, pending }) =>
      Effect.gen(function* () {
        const updatesAtSend: number[] = []
        yield* drain(() =>
          Effect.sync(() => {
            updatesAtSend.push(
              statements.filter((operation) => operation === "update").length,
            )
            advance(120_000)
          }),
        )
        expect(updatesAtSend).toEqual([1, 1, 2, 2])
        expect(sent).toHaveLength(4)
        expect(yield* pending()).toEqual([])
      }),
    )
  })

  it("stops at lease expiry and recovers the remaining jobs", async () => {
    await runScenario(4, ({ drain, advance, statements, sent, pending }) =>
      Effect.gen(function* () {
        yield* drain(() => Effect.sync(() => advance(300_000)))
        expect(sent).toHaveLength(1)
        expect(yield* pending()).toHaveLength(3)
        expect(
          statements.filter((operation) => operation === "update"),
        ).toHaveLength(1)
        yield* drain()
        expect(sent).toHaveLength(4)
        expect(yield* pending()).toEqual([])
      }),
    )
  })

  it.each([0, 240_000])(
    "continues other dispatches after ownership loss between sends (elapsed %i ms)",
    async (elapsed) => {
      await runScenario(
        4,
        ({
          ops,
          sql,
          jobs,
          drain,
          now,
          advance,
          sent,
          pending,
          beforeTimeRead,
        }) =>
          Effect.gen(function* () {
            const healthyDispatchId = `${dispatchId}-healthy`
            const healthyJobs = jobs.map((job) => ({
              ...job,
              sourceScheduledFlowId: healthyDispatchId,
              logicalJobId: `${job.logicalJobId}:healthy`,
            }))
            yield* ops.insertFlowDispatchJobs(healthyJobs)
            let reclaimed = false
            // The next clock read happens after the first send, before
            // the next ownership check. Both drainers use real persistence ops.
            beforeTimeRead(() =>
              Effect.gen(function* () {
                if (reclaimed || sent.length !== 1) return
                reclaimed = true
                advance(elapsed)
                const rows = yield* sql<{ receipt: string }>`
              SELECT claim_receipt AS receipt FROM pf_job_queue LIMIT 1`
                yield* ops.releaseFlowDispatchJobs(dispatchId, rows[0]!.receipt)
                const claimed = yield* ops.claimFlowDispatchJobs(
                  dispatchId,
                  now(),
                  DateTime.add(now(), { minutes: 5 }),
                  "replacement",
                )
                expect(claimed).toHaveLength(4)
              }),
            )
            yield* drain()
            expect(sent).toHaveLength(5)
            expect(sent.slice(1).map((job) => job.logicalJobId)).toEqual(
              healthyJobs.map((job) => job.logicalJobId),
            )
            expect(yield* ops.queryFlowDispatchJobs(healthyDispatchId)).toEqual(
              [],
            )
            expect(yield* pending()).toHaveLength(4)
            yield* ops.releaseFlowDispatchJobs(dispatchId, "replacement")
            yield* drain()
            expect(sent).toHaveLength(9)
            expect(yield* pending()).toEqual([])
          }),
      )
    },
  )

  it("fences acknowledgment after reclaim during enqueue and replays the same logical job", async () => {
    await runScenario(4, ({ ops, sql, drain, now, advance, sent, pending }) =>
      Effect.gen(function* () {
        yield* drain(() =>
          Effect.gen(function* () {
            advance(300_001)
            const rows = yield* sql<{ receipt: string }>`
              SELECT claim_receipt AS receipt FROM pf_job_queue LIMIT 1`
            const staleReceipt = rows[0]!.receipt
            const reclaimed = yield* ops.claimFlowDispatchJobs(
              dispatchId,
              now(),
              DateTime.add(now(), { minutes: 5 }),
              "replacement",
            )
            expect(reclaimed).toHaveLength(4)
            expect(
              yield* ops.deleteFlowDispatchJob(reclaimed[0]!.id, staleReceipt),
            ).toBe(false)
            expect(
              yield* ops.extendFlowDispatchClaim(
                dispatchId,
                staleReceipt,
                DateTime.add(now(), { minutes: 5 }),
              ),
            ).toBe(false)
            yield* ops.releaseFlowDispatchJobs(dispatchId, staleReceipt)
          }),
        )
        expect(sent).toHaveLength(1)
        expect(yield* pending()).toHaveLength(4)
        const owners = yield* sql<{ receipt: string }>`
          SELECT DISTINCT claim_receipt AS receipt FROM pf_job_queue`
        expect(owners).toEqual([{ receipt: "replacement" }])
        yield* ops.releaseFlowDispatchJobs(dispatchId, "replacement")
        yield* drain()
        expect(sent).toHaveLength(5)
        expect(sent[1]).toEqual(sent[0])
        expect(new Set(sent.map((job) => job.logicalJobId)).size).toBe(4)
        expect(yield* pending()).toEqual([])
      }),
    )
  })

  it.each(["renewal", "acknowledgment"])(
    "releases and recovers after a real SQL %s failure",
    async (failure) => {
      await runScenario(4, ({ sql, drain, advance, sent, pending }) =>
        Effect.gen(function* () {
          if (failure === "renewal") {
            yield* sql`CREATE TEMP TRIGGER dispatch_fault
              BEFORE UPDATE OF locked_until ON pf_job_queue
              WHEN NEW.claim_receipt = OLD.claim_receipt
                AND NEW.locked_until != OLD.locked_until
              BEGIN SELECT RAISE(FAIL, 'renewal failed'); END`
          } else {
            yield* sql`CREATE TEMP TRIGGER dispatch_fault
              BEFORE DELETE ON pf_job_queue
              BEGIN SELECT RAISE(FAIL, 'acknowledgment failed'); END`
          }
          const error = yield* drain(() =>
            Effect.sync(() => advance(240_000)),
          ).pipe(Effect.flip)
          expect(error).toBeInstanceOf(SqlError)
          expect(sent).toHaveLength(failure === "renewal" ? 1 : 4)
          expect(yield* pending()).toHaveLength(failure === "renewal" ? 3 : 4)
          const owners = yield* sql<{
            receipt: string | null
            locked: number | null
          }>`
            SELECT DISTINCT claim_receipt AS receipt, locked_until AS locked
            FROM pf_job_queue`
          expect(owners).toEqual([{ receipt: null, locked: null }])
          yield* sql`DROP TRIGGER dispatch_fault`
          yield* drain()
          expect(sent).toHaveLength(failure === "renewal" ? 4 : 8)
          if (failure === "acknowledgment") expect(sent[4]).toEqual(sent[0])
          expect(new Set(sent.map((job) => job.logicalJobId)).size).toBe(4)
          expect(yield* pending()).toEqual([])
        }),
      )
    },
  )
})
