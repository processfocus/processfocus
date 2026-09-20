import { DateTime, Effect, Either, Exit, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  DraftProcessExecutionQueries,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteDraftProcessExecutionQueriesLive } from "../src/lib/draft-process-execution"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { describe, expect, it } from "bun:test"

describe("draft-process-execution", () => {
  // Provide a fixed timestamp for tests
  const requestTime = DateTime.unsafeMake(Date.now())
  const RequestTimeTest = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(requestTime),
  )

  // Provide test user details
  const UserDetailsTest = Layer.succeed(
    UserDetails,
    FiberRef.unsafeMake({
      by: "TEST_USER",
      id: "usr-test",
    }) as FiberRef.FiberRef<UserDetailsValue>,
  )

  const TestLayer = Layer.provideMerge(
    Layer.mergeAll(
      SqliteDraftProcessExecutionQueriesLive,
      SqliteDbOperationsLive,
      RequestTimeTest,
      UserDetailsTest,
    ),
    DatabaseTest,
  )

  describe("insertProcessState", () => {
    it("should reject insert with non-existing processId due to foreign key constraint", async () => {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const queries = yield* DraftProcessExecutionQueries

          // Attempt to insert a processState with a non-existing processId
          yield* queries.insertProcessState(
            "pst-test-123",
            "prc-nonexistent",
            "nonexistent/step",
            { step: "initial", data: "test" },
          )
        }).pipe(Effect.provide(TestLayer)),
      )

      // Expect the effect to fail
      expect(Exit.isFailure(result)).toBe(true)

      if (Exit.isFailure(result)) {
        // Extract the full error information including nested causes
        const errorDetails = Effect.runSync(
          Effect.catchAll(Effect.fail(result.cause), (error) =>
            Effect.succeed(JSON.stringify(error, null, 2)),
          ),
        )

        // Verify it's either a StepNotFoundError (step doesn't exist) or a foreign key constraint error
        expect(errorDetails.toLowerCase()).toMatch(
          /stepnotfounderror|constraint/,
        )
      }
    })
  })

  describe("updateProcessState", () => {
    it("should fail when updating a deleted process state", async () => {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const queries = yield* DraftProcessExecutionQueries

          yield* db
            .insert(schema.user)
            .values({
              id: "usr-test",
              provider: "test",
              sub: "draft-owner",
              lastLoggedIn: DateTime.unsafeMake(Date.now()),
            })
            .onConflictDoNothing()

          // Setup: Insert an orgUnit first (required by foreign key)
          yield* db.insert(schema.orgUnit).values({
            id: "org-update-deleted-test",
            name: "Test Org Update Deleted",
            orgUnitLevel: "organisation",
            path: "org-update-deleted-test",
          })

          // Setup: Insert a process (required by foreign key)
          yield* db.insert(schema.process).values({
            id: "prc-update-deleted-test",
            name: "Test Process Update Deleted",
            orgUnitId: "org-update-deleted-test",
            path: "org-update-deleted-test/process",
            purpose: "Test purpose",
          })

          // Setup: Insert a role (required by foreign key)
          yield* db.insert(schema.role).values({
            id: "role-update-deleted-test",
            name: "Test Role",
            orgUnitId: "org-update-deleted-test",
            path: "org-update-deleted-test/role",
          })

          // Setup: Insert a step (required by foreign key)
          yield* db.insert(schema.step).values({
            id: "stp-update-deleted-test",
            name: "Test Step",
            purpose: "Test step purpose",
            processId: "prc-update-deleted-test",
            roleId: "role-update-deleted-test",
            path: "org-update-deleted-test/process/step",
          })

          // Setup: Insert a deleted process state
          yield* db.insert(schema.processState).values({
            id: "pst-update-deleted-test",
            processId: "prc-update-deleted-test",
            startStepId: "stp-update-deleted-test",
            state: { data: "test" },
            startedByUserId: "usr-test",
            _deleted: true,
          })

          // Attempt to update the deleted process state
          yield* queries.updateProcessState(
            "pst-update-deleted-test",
            {
              data: "updated",
            },
            {
              id: "pst-update-deleted-test",
              processId: "prc-update-deleted-test",
              startStepPath: "org-update-deleted-test/process/step",
              state: { data: "test" },
              updatedAt: Date.now(),
              deleted: true,
            },
          )
        }).pipe(Effect.provide(TestLayer)),
      )

      // Expect the effect to fail
      expect(Exit.isFailure(result)).toBe(true)

      if (Exit.isFailure(result)) {
        // Extract the error
        const errorDetails = Effect.runSync(
          Effect.catchAll(Effect.fail(result.cause), (error) =>
            Effect.succeed(JSON.stringify(error, null, 2)),
          ),
        )

        // Verify it's an UpdateDeletedDocumentError
        expect(errorDetails).toContain("UpdateDeletedDocumentError")
        expect(errorDetails).toContain("pst-update-deleted-test")
        expect(errorDetails).toContain(
          "Cannot update deleted process execution state",
        )
      }
    })

    it("should successfully update non-deleted process state", async () => {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const queries = yield* DraftProcessExecutionQueries

          yield* db
            .insert(schema.user)
            .values({
              id: "usr-test",
              provider: "test",
              sub: "draft-owner",
              lastLoggedIn: DateTime.unsafeMake(Date.now()),
            })
            .onConflictDoNothing()

          // Setup: Insert an orgUnit first (required by foreign key)
          yield* db.insert(schema.orgUnit).values({
            id: "org-update-active-test",
            name: "Test Org Update Active",
            orgUnitLevel: "organisation",
            path: "org-update-active-test",
          })

          // Setup: Insert a process (required by foreign key)
          yield* db.insert(schema.process).values({
            id: "prc-update-active-test",
            name: "Test Process Update Active",
            orgUnitId: "org-update-active-test",
            path: "org-update-active-test/process",
            purpose: "Test purpose",
          })

          // Setup: Insert a role (required by foreign key)
          yield* db.insert(schema.role).values({
            id: "role-update-active-test",
            name: "Test Role",
            orgUnitId: "org-update-active-test",
            path: "org-update-active-test/role",
          })

          // Setup: Insert a step (required by foreign key)
          yield* db.insert(schema.step).values({
            id: "stp-update-active-test",
            name: "Test Step",
            purpose: "Test step purpose",
            processId: "prc-update-active-test",
            roleId: "role-update-active-test",
            path: "org-update-active-test/process/step",
          })

          // Setup: Insert a non-deleted process state (and NOT a process execution, so it's a draft)
          yield* db.insert(schema.processState).values({
            id: "pst-update-active-test",
            processId: "prc-update-active-test",
            startStepId: "stp-update-active-test",
            state: { first: "one", second: "two" },
            startedByUserId: "usr-test",
            createdAt: requestTime,
            updatedAt: requestTime,
            _deleted: false,
          })

          const current = yield* queries.getProcessStates([
            "pst-update-active-test",
          ])
          const assumedMasterState = current[0]
          expect(assumedMasterState).toBeDefined()
          if (!assumedMasterState) return

          const staleUpdate = yield* Effect.exit(
            queries.updateProcessState(
              "pst-update-active-test",
              { data: "stale" },
              {
                ...assumedMasterState,
                updatedAt: assumedMasterState.updatedAt - 1,
              },
            ),
          )
          expect(Exit.isFailure(staleUpdate)).toBe(true)
          expect(
            (yield* queries.getProcessStates(["pst-update-active-test"]))[0]
              ?.state,
          ).toEqual({ first: "one", second: "two" })

          const staleDelete = yield* Effect.exit(
            queries.deleteProcessState("pst-update-active-test", {
              ...assumedMasterState,
              updatedAt: assumedMasterState.updatedAt - 1,
            }),
          )
          expect(Exit.isFailure(staleDelete)).toBe(true)
          expect(
            (yield* queries.getProcessStates(["pst-update-active-test"]))[0]
              ?.deleted,
          ).toBe(false)

          // Update the process state
          yield* queries.updateProcessState(
            "pst-update-active-test",
            { data: "updated" },
            {
              ...assumedMasterState,
              state: { second: "two", first: "one" },
            },
          )

          const updatedMasterState = (yield* queries.getProcessStates([
            "pst-update-active-test",
          ]))[0]
          expect(updatedMasterState).toBeDefined()
          if (!updatedMasterState) return

          const concurrentUpdates = yield* Effect.all(
            [
              Effect.either(
                queries.updateProcessState(
                  "pst-update-active-test",
                  { data: "concurrent-a" },
                  updatedMasterState,
                ),
              ),
              Effect.either(
                queries.updateProcessState(
                  "pst-update-active-test",
                  { data: "concurrent-b" },
                  updatedMasterState,
                ),
              ),
            ],
            { concurrency: "unbounded" },
          )
          expect(concurrentUpdates.filter(Either.isRight)).toHaveLength(1)

          const concurrentMasterState = (yield* queries.getProcessStates([
            "pst-update-active-test",
          ]))[0]
          expect(concurrentMasterState).toBeDefined()
          if (!concurrentMasterState) return

          const staleConcurrentDelete = yield* Effect.exit(
            queries.deleteProcessState(
              "pst-update-active-test",
              updatedMasterState,
            ),
          )
          expect(Exit.isFailure(staleConcurrentDelete)).toBe(true)

          yield* db.insert(schema.processState).values({
            id: "pst-delete-reordered-test",
            processId: "prc-update-active-test",
            startStepId: "stp-update-active-test",
            state: { first: "one", second: "two" },
            startedByUserId: "usr-test",
            createdAt: requestTime,
            updatedAt: requestTime,
            _deleted: false,
          })
          const deleteMasterState = (yield* queries.getProcessStates([
            "pst-delete-reordered-test",
          ]))[0]
          expect(deleteMasterState).toBeDefined()
          if (!deleteMasterState) return
          yield* queries.deleteProcessState("pst-delete-reordered-test", {
            ...deleteMasterState,
            state: { second: "two", first: "one" },
          })
          expect(
            (yield* queries.getProcessStates(["pst-delete-reordered-test"]))[0]
              ?.deleted,
          ).toBe(true)

          yield* db.insert(schema.processExecution).values({
            id: "pex-update-active-test",
            processStateId: "pst-update-active-test",
            createdAt: requestTime,
            updatedAt: requestTime,
          })

          expect(
            yield* queries.getProcessStates(["pst-update-active-test"]),
          ).toEqual([])
          const liveUpdate = yield* Effect.exit(
            queries.updateProcessState(
              "pst-update-active-test",
              { data: "must-not-write" },
              updatedMasterState,
            ),
          )
          expect(Exit.isFailure(liveUpdate)).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      )

      // Expect the effect to succeed
      expect(Exit.isSuccess(result)).toBe(true)
    })
  })
})
