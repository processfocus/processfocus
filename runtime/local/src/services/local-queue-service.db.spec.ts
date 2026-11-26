import { EnqueueError, QueueService } from "@processfocus/runtime"
import { DateTime, Duration, Effect, Layer, Option, Result } from "effect"
import { SqlClient } from "effect/sql"
import { UserDetails } from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  LocalQueueServiceLive,
  makeLocalQueueServiceLayer,
} from "./local-queue-service"
import { expect, it } from "bun:test"

const base = Layer.mergeAll(
  DatabaseTest,
  Layer.succeed(RequestTime, DateTime.nowUnsafe()),
  Layer.succeed(UserDetails, { by: "operator", id: "operator" }),
)

it("admits declared custom and separate consumers but rejects absent consumers without persisting work", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* QueueService
      const sql = yield* SqlClient.SqlClient
      for (const delayed of [false, true]) {
        const result = yield* (
          delayed
            ? queue.enqueueWithDelay("undeclared", {}, Duration.zero)
            : queue.enqueue("undeclared", {})
        ).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(EnqueueError)
          expect(result.failure.message).toContain("PF_LOCAL_QUEUE_CONSUMERS")
          expect(result.failure.message).toContain("undeclared")
        }
      }
      expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
      for (const name of ["custom", "separate"]) {
        const id = yield* queue.enqueue(name, { task: name })
        const claim = yield* queue.rawClaim(name)
        expect(Option.isSome(claim)).toBe(true)
        if (Option.isSome(claim)) {
          expect(claim.value.jobId).toBe(id)
          expect(claim.value.payload).toEqual({ task: name })
          yield* queue.acknowledge(id, claim.value.receipt)
        }
      }
      expect(yield* sql`SELECT id FROM pf_job_queue`).toEqual([])
    }).pipe(
      Effect.provide(
        makeLocalQueueServiceLayer({
          custom: "organisation CustomJobLayer",
          separate: "separately hosted worker",
        }).pipe(Layer.provideMerge(base)),
      ),
    ),
  )
})

it("fails runtime composition for invalid consumer declarations", async () => {
  for (const config of [
    null,
    [],
    "worker",
    { custom: "" },
    { custom: 42 },
    { "invalid queue": "worker" },
  ]) {
    const result = await Effect.runPromise(
      QueueService.pipe(
        Effect.provide(
          makeLocalQueueServiceLayer(config).pipe(Layer.provide(base)),
        ),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
  }
})

it("loads shared producer declarations from the local runtime environment", async () => {
  const previous = process.env["PF_LOCAL_QUEUE_CONSUMERS"]
  try {
    for (const config of ["not json", '{"external":"external worker"}']) {
      process.env["PF_LOCAL_QUEUE_CONSUMERS"] = config
      const result = await Effect.runPromise(
        Effect.flatMap(QueueService, (queue) =>
          queue.enqueue("external", {}),
        ).pipe(
          Effect.provide(LocalQueueServiceLive.pipe(Layer.provide(base))),
          Effect.result,
        ),
      )
      expect(Result.isSuccess(result)).toBe(config.startsWith("{"))
    }
  } finally {
    if (previous === undefined) delete process.env["PF_LOCAL_QUEUE_CONSUMERS"]
    else process.env["PF_LOCAL_QUEUE_CONSUMERS"] = previous
  }
})
