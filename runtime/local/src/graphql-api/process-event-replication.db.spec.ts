import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ProcessCollectionQueries,
  UserDetails,
} from "@pf/graphql-db-operations"
import {
  PROCESS_EVENT_QUEUE,
  ProcessFromJobPublishError,
  ProcessFromJobPublisher,
  processEventHandler,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import { Form, Organisation, Process, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { expect, it } from "bun:test"

it("makes execution-derived Process changes pullable before publishing their resync notification", async () => {
  const org = new Organisation({ name: "Process statistics" })
  const role = new Role(org, "Employee", { name: "Employee" })
  const process = new Process(org, "Work", { name: "Work", purpose: "Work" })
  const start = new Form(process, "Start", { role, form: () => ({}) })
  const finish = new Form(process, "Finish", { role, form: () => ({}) })
  process.start(start).next(finish).end()
  const now = DateTime.makeUnsafe("2026-10-13T00:00:00Z")
  const layers = Layer.mergeAll(
    SqliteDbOperationsLive,
    SqliteGraphqlDbOperationsLive,
    SqliteCompletedJobOperationsLive,
    Layer.succeed(RequestTime, now),
    Layer.succeed(UserDetails, { by: "TEST", id: null }),
  ).pipe(Layer.provideMerge(DatabaseTest))

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storeOrganisation(org)
      const queries = yield* ProcessCollectionQueries
      const db = yield* TypedSqliteDrizzle
      const [initial] = yield* queries.pullProcess(null, 50)
      if (!initial) throw new Error("Missing process fixture")
      let checkpoint = { id: initial.id, updatedAt: initial.updatedAt }
      expect(initial.activeInstances).toBe(0)
      const [flow] = yield* db.select().from(schema.flow)
      if (!flow) throw new Error("Missing flow fixture")
      yield* db.insert(schema.processState).values({
        id: "state",
        processId: initial.id,
        startStepId: flow.sourceStepId,
        state: {},
      })
      yield* db.insert(schema.processExecution).values({
        id: "execution",
        processStateId: "state",
        createdAt: now,
      })
      yield* db.insert(schema.toDo).values({
        id: "todo",
        processExecutionId: "execution",
        flowId: flow.id,
      })

      const job = {
        jobId: "statistics-start",
        receipt: "statistics-receipt",
        queue: PROCESS_EVENT_QUEUE,
        payload: { processId: initial.id },
        attempts: 1,
        maxAttempts: 5,
        availableAt: now,
        lockedUntil: now,
      }
      let expectedActive = 1
      let notifications = 0
      // Only replace external transport. A notification recipient resyncs using
      // its existing checkpoint against the real migrated database.
      const publisher = Layer.succeed(ProcessFromJobPublisher, {
        publishProcessChanged: () =>
          Effect.gen(function* () {
            notifications++
            const rows = yield* queries.pullProcess(checkpoint, 50)
            expect(rows).toHaveLength(1)
            const row = rows[0]
            if (!row)
              throw new Error("Process update missing after notification")
            expect(row.id).toBe(initial.id)
            expect(row.activeInstances).toBe(expectedActive)
            expect(row.updatedAt).toBeGreaterThan(checkpoint.updatedAt)
            if (expectedActive === 0) {
              expect(Math.round(row.minDurationMs ?? 0)).toBe(60000)
              expect(Math.round(row.maxDurationMs ?? 0)).toBe(60000)
            }
            checkpoint = { id: row.id, updatedAt: row.updatedAt }
            return "published" as const
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProcessFromJobPublishError({
                  processId: initial.id,
                  cause,
                }),
            ),
          ),
      })
      yield* processEventHandler.handle(job).pipe(Effect.provide(publisher))
      expect(yield* queries.pullProcess(checkpoint, 50)).toEqual([])
      // A repeated delivery must not manufacture another revision/notification.
      yield* processEventHandler.handle(job).pipe(Effect.provide(publisher))
      expect(notifications).toBe(1)
      expect(yield* queries.pullProcess(checkpoint, 50)).toEqual([])

      yield* db
        .update(schema.toDo)
        .set({ _deleted: true })
        .where(eq(schema.toDo.id, "todo"))
      yield* db
        .update(schema.processExecution)
        .set({ finishedAt: DateTime.add(now, { minutes: 1 }) })
        .where(eq(schema.processExecution.id, "execution"))
      expectedActive = 0
      yield* processEventHandler
        .handle({ ...job, jobId: "statistics-finish" })
        .pipe(Effect.provide(publisher))
      expect(notifications).toBe(2)
      expect(yield* queries.pullProcess(checkpoint, 50)).toEqual([])
    }).pipe(Effect.provide(layers)),
  )
})
