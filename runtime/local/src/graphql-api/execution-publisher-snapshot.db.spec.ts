import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FetchHttpClient } from "@effect/platform"
import { ConfigProvider, DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ExecutionCollectionOpsLive,
  SlaCalculationServiceLive,
} from "@pf/graphql-api"
import {
  ExecutionQueries,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { ExecutionFromJobPublisher } from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  Form,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTestFile,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { HttpExecutionFromJobPublisherLive } from "../services/http-execution-from-job-publisher"
import { Database } from "bun:sqlite"
import { expect, it } from "bun:test"

it("publishes one execution snapshot and releases it before HTTP delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-publisher-snapshot-"))
  const filename = join(directory, "pf.db")
  const org = new Organisation({ name: "Snapshot regression" })
  const role = new Role(org, "Manager", { name: "Manager" })
  const process = new Process(org, "Review", {
    name: "Review",
    purpose: "Snapshot regression",
  })
  const start = new Form(process, "Start", {
    name: "Start",
    role,
    form: () => ({}),
  })
  const review = new Form(process, "Review", {
    name: "Review",
    role,
    form: () => ({}),
  })
  process.start(start).next(review).end()
  const now = DateTime.unsafeMake("2026-09-08T07:41:38Z")
  const database = DatabaseTestFile(filename)
  const layers = Layer.mergeAll(
    SqliteDbOperationsLive,
    SqliteGraphqlDbOperationsLive,
    Layer.succeed(RequestTime, FiberRef.unsafeMake(now)),
    Layer.succeed(
      UserDetails,
      FiberRef.unsafeMake<UserDetailsValue>({ by: "TEST", id: null }),
    ),
    OrganisationProviderTest(org),
  ).pipe(Layer.provideMerge(database))

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* storeOrganisation(org)
          const db = yield* TypedSqliteDrizzle
          const [flow] = yield* db.select().from(schema.flow)
          const [storedProcess] = yield* db.select().from(schema.process)
          expect(flow).toBeDefined()
          expect(storedProcess).toBeDefined()
          yield* db.insert(schema.processState).values({
            id: "state",
            processId: storedProcess!.id,
            startStepId: flow!.sourceStepId,
            state: { revision: "before" },
          })
          yield* db
            .insert(schema.processExecution)
            .values({ id: "execution", processStateId: "state" })
          yield* db.insert(schema.toDo).values({
            id: "todo",
            processExecutionId: "execution",
            flowId: flow!.id,
          })

          const writer = yield* Effect.acquireRelease(
            Effect.sync(() => new Database(filename)),
            (connection) => Effect.sync(() => connection.close()),
          )
          writer.exec("PRAGMA busy_timeout = 0")
          const delivered: unknown[] = []
          let deliveryWrites = 0
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(request) {
                  delivered.push(await request.json())
                  // This must run after the publisher releases its read snapshot.
                  expect(
                    writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get(),
                  ).toMatchObject({ busy: 0 })
                  writer
                    .query("UPDATE pf_process_state SET state = ? WHERE id = ?")
                    .run(JSON.stringify({ revision: "delivered" }), "state")
                  deliveryWrites += 1
                  return new Response(null, { status: 204 })
                },
              }),
            ),
            (value) => Effect.sync(() => value.stop(true)),
          )
          const queries = yield* ExecutionQueries
          const [before] = yield* queries.getExecutions(["execution"])
          expect(before).toBeDefined()
          let interleaved = false
          const statesRead: unknown[] = []
          const observedQueries = Layer.succeed(ExecutionQueries, {
            ...queries,
            getExecutions: (ids) =>
              queries.getExecutions(ids).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (interleaved) return
                    interleaved = true
                    // Commit between the real execution-row query and the real Todo query.
                    writer.transaction(() => {
                      writer.exec(
                        "UPDATE pf_process_execution SET finished_at = updated_at + 1, updated_at = updated_at + 1, business_duration = 5000 WHERE id = 'execution'",
                      )
                      writer.exec(
                        "UPDATE pf_to_do SET _deleted = 1, updated_at = updated_at + 1 WHERE id = 'todo'",
                      )
                      writer
                        .query(
                          "UPDATE pf_process_state SET state = ? WHERE id = ?",
                        )
                        .run(JSON.stringify({ revision: "after" }), "state")
                    })()
                  }),
                ),
              ),
            getProcessStateByExecutionId: (id) =>
              queries.getProcessStateByExecutionId(id).pipe(
                Effect.tap((state) =>
                  Effect.sync(() => {
                    statesRead.push(state)
                  }),
                ),
              ),
          })
          const publisherLayer = HttpExecutionFromJobPublisherLive.pipe(
            Layer.provide(
              ExecutionCollectionOpsLive.pipe(
                Layer.provide(SlaCalculationServiceLive),
                Layer.provide(observedQueries),
              ),
            ),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              Layer.setConfigProvider(
                ConfigProvider.fromMap(
                  new Map([["GRAPHQL_SERVER_URL", server.url.origin]]),
                ),
              ),
            ),
          )
          yield* Effect.gen(function* () {
            const publisher = yield* ExecutionFromJobPublisher
            expect(yield* publisher.publishExecutionChanged("execution")).toBe(
              "published",
            )
            expect(interleaved).toBe(true)
            expect(statesRead).toEqual([{ revision: "before" }])
            expect(delivered).toHaveLength(1)
            expect(delivered[0]).toMatchObject({
              documents: [
                {
                  id: "execution",
                  status: "Running",
                  finishedAt: null,
                  durationMs: before!.durationMs,
                  updatedAt: before!.updatedAt,
                  steps: expect.arrayContaining([
                    expect.objectContaining({ id: "todo", status: "Waiting" }),
                  ]),
                },
              ],
            })
            expect(deliveryWrites).toBe(1)
            const [after] = yield* queries.getExecutions(["execution"])
            expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt)
            expect(yield* publisher.publishExecutionChanged("execution")).toBe(
              "published",
            )
            expect(delivered[1]).toMatchObject({
              documents: [
                {
                  id: "execution",
                  status: "Completed",
                  finishedAt: after!.finishedAt,
                  durationMs: after!.durationMs,
                  updatedAt: after!.updatedAt,
                  steps: expect.arrayContaining([
                    expect.objectContaining({
                      id: "todo",
                      status: "Completed",
                    }),
                  ]),
                },
              ],
              checkpoint: { id: "execution", updatedAt: after!.updatedAt },
            })
            expect(deliveryWrites).toBe(2)
            expect(yield* publisher.publishExecutionChanged("missing")).toBe(
              "skipped-not-found",
            )
            expect(delivered).toHaveLength(2)
          }).pipe(Effect.provide(publisherLayer))
        }).pipe(Effect.provide(layers)),
      ),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
