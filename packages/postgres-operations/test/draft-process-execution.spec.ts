import { expect, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  DraftProcessExecutionQueries,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresDraftProcessExecutionQueriesLive } from "../src/lib/draft-process-execution"
import { PostgresDbOperationsLive } from "../src/lib/org-to-db"
import { PostgresTest } from "./postgres-test"

// Provide a fixed timestamp for tests
const RequestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
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
    PostgresDbOperationsLive,
    PostgresDraftProcessExecutionQueriesLive,
    RequestTimeTest,
    UserDetailsTest,
  ),
  PostgresTest,
)

it.layer(TestLayer, { timeout: "60 seconds" })(
  "draft-process-execution",
  (it) => {
    it.effect(
      "should reject insert with non-existing processId due to foreign key constraint",
      () =>
        Effect.gen(function* () {
          const queries = yield* DraftProcessExecutionQueries

          // Attempt to insert a processState with a non-existing processId
          const result = yield* Effect.exit(
            queries.insertProcessState(
              "pst-test-123",
              "prc-nonexistent",
              "nonexistent/step",
              { step: "initial", data: "test" },
            ),
          )

          // Expect the effect to fail
          expect(Exit.isFailure(result)).toBe(true)

          if (Exit.isFailure(result)) {
            // Extract the full error information including nested causes
            const errorDetails = Cause.pretty(result.cause)

            // Verify it's either a StepNotFoundError (step doesn't exist) or a foreign key constraint error
            // Postgres returns error code "23503" for FK violations or check for constraint_name containing "fk"
            expect(errorDetails.toLowerCase()).toMatch(
              /stepnotfounderror|code.*23503|constraint_name.*fk/,
            )
          }
        }),
    )

    it.effect("should fail when updating a deleted process state", () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
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
        const result = yield* Effect.exit(
          queries.updateProcessState(
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
          ),
        )

        // Expect the effect to fail
        expect(Exit.isFailure(result)).toBe(true)

        if (Exit.isFailure(result)) {
          // Extract the full error information
          const errorDetails = Cause.pretty(result.cause)

          // Verify it's an UpdateDeletedDocumentError
          expect(errorDetails).toContain("UpdateDeletedDocumentError")
          expect(errorDetails).toContain("pst-update-deleted-test")
          expect(errorDetails).toContain(
            "Cannot update deleted process execution state",
          )
        }
      }),
    )

    it.effect("should successfully update non-deleted process state", () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
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

        // Setup: Insert a non-deleted process state
        yield* db.insert(schema.processState).values({
          id: "pst-update-active-test",
          processId: "prc-update-active-test",
          startStepId: "stp-update-active-test",
          state: { data: "original" },
          startedByUserId: "usr-test",
          _deleted: false,
        })

        const current = yield* queries.getProcessStates([
          "pst-update-active-test",
        ])
        const assumedMasterState = current[0]
        expect(assumedMasterState).toBeDefined()
        if (!assumedMasterState) return

        // Update the process state
        const processStateId = yield* queries.updateProcessState(
          "pst-update-active-test",
          { data: "updated" },
          assumedMasterState,
        )

        // Verify the update succeeded
        expect(processStateId).toBe("pst-update-active-test")

        // Verify the state was updated and _deleted is still false
        const updated = yield* db.query.processState.findFirst({
          where: { id: "pst-update-active-test" },
        })

        expect(updated?.state).toEqual({ data: "updated" })
        expect(updated?._deleted).toBe(false)
      }),
    )
  },
)
