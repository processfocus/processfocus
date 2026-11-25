import { QueueService } from "@processfocus/runtime"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import { jobQueue } from "@pf/drizzle-sqlite"
import { UserDetails } from "@pf/graphql-db-operations"
import {
  PROJECT_ACCOUNTING_QUEUE,
  ProjectAccountingEvents,
} from "@pf/project-accounting"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { makeLocalQueueServiceLayer } from "./local-queue-service"
import { ProjectAccountingEventsLive } from "./project-accounting-events"
import { expect, it } from "bun:test"

it("recovers durable local publication after failed acknowledgement and isolates project subscribers", async () => {
  const base = Layer.mergeAll(
    DatabaseTest,
    Layer.succeed(RequestTime, DateTime.nowUnsafe()),
    Layer.succeed(UserDetails, { by: "operator", id: "operator" }),
  )
  const queue = makeLocalQueueServiceLayer({}).pipe(Layer.provideMerge(base))
  const runtime = ManagedRuntime.make(
    ProjectAccountingEventsLive.pipe(Layer.provideMerge(queue)),
  )
  try {
    const events = await runtime.runPromise(ProjectAccountingEvents)
    const first = (
      await runtime.runPromise(events.subscribe("project-a", "customer-a"))
    )[Symbol.asyncIterator]()
    const other = (
      await runtime.runPromise(events.subscribe("project-b", "customer-b"))
    )[Symbol.asyncIterator]()
    const sql = await runtime.runPromise(SqlClient.SqlClient)
    await runtime.runPromise(
      sql.unsafe(
        "CREATE TRIGGER fail_ack BEFORE DELETE ON pf_job_queue WHEN OLD.queue = 'project-accounting-event' BEGIN SELECT RAISE(ABORT, 'injected interrupted dispatch'); END",
      ),
    )
    const id = await runtime.runPromise(
      Effect.flatMap(QueueService, (q) =>
        q.enqueue(PROJECT_ACCOUNTING_QUEUE, { projectId: "project-a" }),
      ),
    )
    expect(await first.next()).toEqual({
      done: false,
      value: { projectId: "project-a" },
    })
    // Let the failed delete finish, then recover its existing durable row.
    await runtime.runPromise(Effect.sleep("300 millis"))
    const db = await runtime.runPromise(TypedSqliteDrizzle)
    expect(
      await runtime.runPromise(
        db.select().from(jobQueue).where(eq(jobQueue.id, id)),
      ),
    ).toHaveLength(1)
    await runtime.runPromise(sql.unsafe("DROP TRIGGER fail_ack"))
    await runtime.runPromise(
      db
        .update(jobQueue)
        .set({ lockedUntil: DateTime.makeUnsafe(0) })
        .where(eq(jobQueue.id, id)),
    )
    expect(await first.next()).toEqual({
      done: false,
      value: { projectId: "project-a" },
    })
    await runtime.runPromise(
      events.emit({ recipientPrincipalId: "customer-a" }),
    )
    expect(await first.next()).toEqual({
      done: false,
      value: { recipientPrincipalId: "customer-a" },
    })
    // Other project messages never enter this subscriber's bounded buffer.
    await runtime.runPromise(events.emit({ projectId: "project-b" }))
    expect(await other.next()).toEqual({
      done: false,
      value: { projectId: "project-b" },
    })
    await first.return?.()
    await other.return?.()
    await runtime.runPromise(Effect.sleep("300 millis"))
    expect(
      await runtime.runPromise(
        db.select().from(jobQueue).where(eq(jobQueue.id, id)),
      ),
    ).toEqual([])
  } finally {
    await runtime.dispose()
  }
}, 10000)
