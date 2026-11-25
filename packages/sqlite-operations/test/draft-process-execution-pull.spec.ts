// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "@tursodatabase/database"
import { DateTime, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as schema from "@pf/drizzle-sqlite"
import type { UserDetailsValue } from "@pf/graphql-db-operations"
import {
  DraftProcessExecutionQueries,
  type DraftProcessExecutionRow,
  UserDetails,
} from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import {
  Form,
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  DatabaseTestFile,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteDraftProcessExecutionQueriesLive } from "../src/lib/draft-process-execution"
import { describe, expect, it } from "bun:test"

/**
 * Create a test organisation with a process and a step.
 * Returns the organisation for use with storeOrganisation.
 */
const createTestOrganisation = () => {
  const organisation = new Organisation({
    name: "Acme Corp",
  })

  const finance = new OrgUnit(organisation, "finance", {
    name: "Finance Department",
    type: "department",
  })

  const employeeRole = new Role(finance, "employee", {
    name: "Employee",
  })

  const process = new Process(finance, "expense-approval", {
    name: "Expense Approval",
    purpose: "Approve employee expenses",
  })

  new Form(process, "submit", {
    name: "Submit Expense",
    purpose: "Employee submits expense for approval",
    role: employeeRole,
    form: () => ({}),
  })

  return organisation
}

/**
 * Extract checkpoint from last row for pagination testing.
 */
const getCheckpoint = (rows: DraftProcessExecutionRow[]) => {
  const lastRow = rows[rows.length - 1]
  return lastRow ? { id: lastRow.id, updatedAt: lastRow.updatedAt } : null
}

describe("pullDraftProcessExecution", () => {
  const testOrganisation = createTestOrganisation()

  const RequestTimeTest = Layer.succeed(
    RequestTime,
    DateTime.makeUnsafe(Date.now()),
  )
  const GraphqlOrgLayer = OrganisationProviderTest(testOrganisation)
  const UserDetailsTest = Layer.succeed(UserDetails, {
    by: "TEST_USER",
    id: "usr-draft-owner",
  } as UserDetailsValue)

  const TestLayer = Layer.provideMerge(
    Layer.mergeAll(
      SqliteGraphqlDbOperationsLive,
      SqliteDbOperationsLive,
      RequestTimeTest,
      GraphqlOrgLayer,
      UserDetailsTest,
    ),
    DatabaseTest,
  )

  type TestRequirements = Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          yield* db
            .insert(schema.user)
            .values({
              id: "usr-draft-owner",
              provider: "test",
              sub: "draft-owner",
              createdAt: DateTime.makeUnsafe(Date.now()),
            })
            .onConflictDoNothing()
          return yield* test
        }),
        TestLayer,
      ),
    )
  }

  it("bounds Turso reads for initial pulls, checkpoint pulls, and ID lookups", async () => {
    // The shell exposes statement metrics; the npm driver only exposes plans.
    const shell = Bun.which("tursodb")
    if (!shell) {
      throw new Error(
        "Install the pinned Turso shell with `mise install http:tursodb` and add it to PATH",
      )
    }
    const directory = await mkdtemp(join(tmpdir(), "pf-draft-pull-"))
    const path = join(directory, "drafts.db")
    const unrelatedCount = 250
    const owner = "usr-draft-owner"
    const other = "usr-other-draft-owner"
    const captured: { sql: string; params: readonly unknown[] }[] = []
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeOrganisation(testOrganisation)
          const db = yield* TypedSqliteDrizzle
          const [process] = yield* db.query.process.findMany()
          const [step] = yield* db.query.step.findMany()
          const now = DateTime.makeUnsafe("2026-11-01T00:00:00Z")
          yield* db.insert(schema.user).values(
            [owner, other].map((id) => ({
              id,
              provider: "test",
              sub: id,
              createdAt: now,
            })),
          )
          const state = {
            processId: process!.id,
            startStepId: step!.id,
            state: {},
            createdAt: now,
            updatedAt: now,
          }
          yield* db.insert(schema.processState).values([
            { ...state, id: "draft", startedByUserId: owner },
            {
              ...state,
              id: "tombstone",
              startedByUserId: owner,
              _deleted: true,
            },
          ])
          const unrelated = Array.from({ length: unrelatedCount }, (_, i) => ({
            id: `unrelated-${i}`,
          }))
          // Make the initial pull walk the unrelated states before the draft.
          const earlier = DateTime.subtract(now, { seconds: 1 })
          yield* db.insert(schema.processState).values(
            unrelated.map((row) => ({
              ...state,
              ...row,
              startedByUserId: other,
              updatedAt: earlier,
            })),
          )
          yield* db.insert(schema.processExecution).values(
            unrelated.map(({ id }) => ({
              id: `execution-${id}`,
              processStateId: id,
            })),
          )

          const client = yield* SqlClient.SqlClient
          // Measure the production statements with their original bindings.
          const recordingClient = new Proxy(client, {
            get(target, key, receiver) {
              if (key === "unsafe") {
                return (sql: string, params: readonly unknown[] = []) => {
                  captured.push({ sql, params })
                  return target.unsafe(sql, params)
                }
              }
              return Reflect.get(target, key, receiver)
            },
          })
          yield* Effect.gen(function* () {
            const queries = yield* DraftProcessExecutionQueries
            const first = yield* queries.pullDraftProcessExecution(null, 1)
            expect(first.map(({ id }) => id)).toEqual(["draft"])
            const next = yield* queries.pullDraftProcessExecution(
              getCheckpoint(first),
              10,
            )
            expect(next.map(({ id, deleted }) => ({ id, deleted }))).toEqual([
              { id: "tombstone", deleted: true },
            ])
            const byId = yield* queries.getProcessStates([
              "draft",
              "unrelated-0",
            ])
            expect(byId.map(({ id }) => id)).toEqual(["draft"])
          }).pipe(
            Effect.provide(UserDetailsTest),
            Effect.provide(
              SqliteDraftProcessExecutionQueriesLive.pipe(
                Layer.provide(Layer.fresh(TypedSqliteDrizzleLayer)),
                Layer.provide(
                  Layer.succeed(SqlClient.SqlClient, recordingClient),
                ),
              ),
            ),
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SqliteDbOperationsLive,
              GraphqlOrgLayer,
              RequestTimeTest,
            ).pipe(Layer.provideMerge(DatabaseTestFile(path))),
          ),
        ),
      )
      expect(captured).toHaveLength(3)
      const planPath = join(directory, "plans.db")
      await copyFile(path, planPath)
      const turso = await connect(planPath)
      try {
        for (const [index, query] of captured.entries()) {
          const params = query.params.map((value) => {
            if (typeof value === "string" || typeof value === "number")
              return value
            throw new Error("Unexpected draft query binding")
          })
          const result = Bun.spawnSync([shell, "--quiet", path], {
            stdin: Buffer.from(
              [
                ...params.map(
                  (value, i) =>
                    `.parameter set ?${i + 1} ${JSON.stringify(value)}`,
                ),
                ".stats on",
                `${query.sql};`,
                "",
              ].join("\n"),
            ),
          })
          expect(result.stderr.toString()).toBe("")
          expect(result.exitCode).toBe(0)
          const rowsRead = result.stdout
            .toString()
            .match(/Rows read:\s+(\d+)/)?.[1]
          expect(rowsRead).toBeDefined()
          // Pulls may visit each state once; a targeted ID lookup may not.
          expect(Number(rowsRead)).toBeLessThanOrEqual(
            index === 2 ? 16 : unrelatedCount + 16,
          )
          const plan = JSON.stringify(
            await (await turso.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)).all(
              ...params,
            ),
          )
          expect(plan).not.toContain("SCAN pf_process_state_its_is_draft")
          expect(plan).not.toContain("SCAN pf_process_execution")
          expect(plan).toContain("pf_process_execution_processstateidx_idx")
          expect(plan).toContain("pf_provider_user_user_unique_idx")
        }
      } finally {
        await turso.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("should return empty array for empty database", () =>
    runTest(
      Effect.gen(function* () {
        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        expect(rows).toHaveLength(0)
      }),
    ))

  it("should return all drafts on initial pull with null checkpoint", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        // Create some draft process states
        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        expect(processes).toHaveLength(1)
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        // Insert draft process states
        const now = yield* DateTime.now
        yield* db.insert(schema.user).values({
          id: "usr-other-draft-owner",
          provider: "test",
          sub: "other-draft-owner",
          createdAt: now,
        })
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft1",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: { foo: "bar" },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft2",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: { baz: "qux" },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-other-users-draft",
            processId,
            startStepId,
            startedByUserId: "usr-other-draft-owner",
            state: { secret: true },
            createdAt: now,
            updatedAt: now,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        expect(rows).toHaveLength(2)
        expect(rows.map((d) => d.id).sort()).toEqual([
          "pst-draft1",
          "pst-draft2",
        ])
        expect(rows[0]?.processId).toBe(processId)
        expect(rows[0]?.name).toBe("Expense Approval")
        expect(rows[0]?.deleted).toBe(false)
      }),
    ))

  it("should respect limit parameter for pagination", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft1",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft2",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft3",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 2)

        expect(rows).toHaveLength(2)
      }),
    ))

  it("should filter by checkpoint updatedAt and id", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now
        const earlier = DateTime.subtract(now, { hours: 1 })
        const later = DateTime.add(now, { hours: 1 })

        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft1",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: earlier,
            updatedAt: earlier,
          },
          {
            id: "pst-draft2",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft3",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: later,
            updatedAt: later,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries

        // Get first result to extract checkpoint
        const firstRows = yield* queries.pullDraftProcessExecution(null, 1)
        expect(firstRows).toHaveLength(1)
        expect(firstRows[0]?.id).toBe("pst-draft1")

        // Use checkpoint to get next results
        const checkpoint = getCheckpoint(firstRows)
        const nextRows = yield* queries.pullDraftProcessExecution(
          checkpoint,
          10,
        )

        // The checkpoint row is excluded; only later drafts are returned.
        expect(nextRows).toHaveLength(2)
        const ids = nextRows.map((d) => d.id)
        expect(ids).toEqual(["pst-draft2", "pst-draft3"])
      }),
    ))

  it("should include soft-deleted drafts in results", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft-active",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
            _deleted: false,
          },
          {
            id: "pst-draft-deleted",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
            _deleted: true,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        expect(rows).toHaveLength(2)
        const deletedDoc = rows.find((d) => d.id === "pst-draft-deleted")
        expect(deletedDoc).toBeDefined()
        expect(deletedDoc?.deleted).toBe(true)

        const activeDoc = rows.find((d) => d.id === "pst-draft-active")
        expect(activeDoc).toBeDefined()
        expect(activeDoc?.deleted).toBe(false)
      }),
    ))

  it("should only return drafts, not executed process states", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now

        // Insert a draft and an executed process state
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-executed",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
        ])

        // Create a process execution for the second process state
        yield* db.insert(schema.processExecution).values({
          id: "pex-1",
          processStateId: "pst-executed",
          createdAt: now,
          updatedAt: now,
        })

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        // Should only get the draft, not the executed one
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe("pst-draft")
      }),
    ))

  it("should order results by updatedAt then id", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now
        const earlier = DateTime.subtract(now, { hours: 2 })
        const later = DateTime.add(now, { hours: 2 })

        // Insert in random order with different timestamps
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft-c",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: later,
            updatedAt: later,
          },
          {
            id: "pst-draft-a",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: earlier,
            updatedAt: earlier,
          },
          {
            id: "pst-draft-b1",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft-b2",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        expect(rows).toHaveLength(4)

        // Should be ordered by updatedAt first
        const ids = rows.map((d) => d.id)
        expect(ids[0]).toBe("pst-draft-a") // earliest
        // Next two have same updatedAt, should be sorted by id
        expect(ids[1]).toBe("pst-draft-b1")
        expect(ids[2]).toBe("pst-draft-b2")
        expect(ids[3]).toBe("pst-draft-c") // latest
      }),
    ))

  it("should derive checkpoint from last document", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft1",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft2",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: {},
            createdAt: now,
            updatedAt: now,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries
        const rows = yield* queries.pullDraftProcessExecution(null, 10)

        expect(rows).toHaveLength(2)

        // Checkpoint should be derived from last document
        const lastRow = rows[rows.length - 1]!
        const checkpoint = getCheckpoint(rows)
        expect(checkpoint).not.toBeNull()
        expect(checkpoint?.id).toBe(lastRow.id)
        expect(checkpoint?.updatedAt).toBe(lastRow.updatedAt)
      }),
    ))

  it("should handle pagination correctly when multiple documents share same updatedAt", () =>
    runTest(
      Effect.gen(function* () {
        yield* storeOrganisation(createTestOrganisation())

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.query.process.findMany()
        const processId = processes[0]!.id

        // Get step id for foreign key
        const steps = yield* db.query.step.findMany()
        const startStepId = steps[0]!.id

        const now = yield* DateTime.now

        // Create 3 drafts with the SAME updatedAt but different ids
        // This tests the critical bug: with AND logic, paging from "pst-draft-a"
        // would skip "pst-draft-b" if it has a lower id but same timestamp
        yield* db.insert(schema.processState).values([
          {
            id: "pst-draft-a",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: { step: "a" },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft-b",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: { step: "b" },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "pst-draft-c",
            processId,
            startStepId,
            startedByUserId: "usr-draft-owner",
            state: { step: "c" },
            createdAt: now,
            updatedAt: now,
          },
        ])

        const queries = yield* DraftProcessExecutionQueries

        // Get first page with limit 1
        const firstPage = yield* queries.pullDraftProcessExecution(null, 1)
        expect(firstPage).toHaveLength(1)
        expect(firstPage[0]?.id).toBe("pst-draft-a")

        // Use the returned checkpoint to get only the remaining documents.
        const checkpoint = getCheckpoint(firstPage)
        const secondPage = yield* queries.pullDraftProcessExecution(
          checkpoint,
          10,
        )

        expect(secondPage).toHaveLength(2)
        const ids = secondPage.map((d) => d.id)
        expect(ids).toEqual(["pst-draft-b", "pst-draft-c"])

        const finalPage = yield* queries.pullDraftProcessExecution(
          getCheckpoint(secondPage),
          10,
        )
        expect(finalPage).toEqual([])
      }),
    ))
})
