import { SqlClient } from "@effect/sql"
import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  ProcessExecutionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresProcessExecutionOperationsLive } from "../src/lib/process-execution"
import { PostgresTest } from "./postgres-test"

const fixedRequestTime = DateTime.unsafeMake("2026-04-06T10:00:00.000Z")

const RequestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(fixedRequestTime),
)

const UserDetailsTest = Layer.succeed(
  UserDetails,
  FiberRef.unsafeMake({
    by: "TEST_USER",
    id: "usr-test-process-execution",
  }) as FiberRef.FiberRef<UserDetailsValue>,
)

const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    PostgresProcessExecutionOperationsLive,
    RequestTimeTest,
    UserDetailsTest,
  ),
  PostgresTest,
)

const ensureTestUser = (suffix: string) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    // Tests share a fixed user id; later cases only need the row to exist,
    // so we intentionally keep the first inserted provider/sub values.
    const existingUser = yield* db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, "usr-test-process-execution"))
      .limit(1)

    if (existingUser[0]) {
      return
    }

    yield* db.insert(schema.user).values({
      id: "usr-test-process-execution",
      provider: `test-provider-${suffix}`,
      sub: `test-sub-${suffix}`,
      lastLoggedIn: fixedRequestTime,
    })
  })

it.layer(TestLayer, { timeout: "60 seconds" })("process-execution", (it) => {
  it.effect("persists a caller-supplied executionId", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const operations = yield* ProcessExecutionOperations
      const suffix = Date.now().toString(36)
      const orgUnitId = `ou-pe-${suffix}`
      const processId = `prc-pe-${suffix}`
      const stepId = `step-pe-${suffix}`
      const stepPath = `/process-execution-${suffix}/start`
      const executionId = `pex-postgres-${suffix}`

      yield* ensureTestUser(suffix)

      yield* db.insert(schema.orgUnit).values({
        id: orgUnitId,
        name: `Process Execution ${suffix}`,
        orgUnitLevel: "organisation",
        path: `/process-execution-${suffix}`,
      })

      yield* db.insert(schema.process).values({
        id: processId,
        orgUnitId,
        name: `Process ${suffix}`,
        path: `/process-execution-${suffix}/process`,
        purpose: "Test process execution inserts",
      })

      yield* db.insert(schema.step).values({
        id: stepId,
        name: "Start",
        purpose: "Start step",
        processId,
        path: stepPath,
      })

      const processState = yield* operations.insertProcessState(
        processId,
        stepPath,
        { hello: "world" },
      )

      expect(processState.stepId).toBe(stepId)

      const persistedExecutionId = yield* operations.insertProcessExecution(
        processState.processStateId,
        executionId,
      )

      expect(persistedExecutionId).toBe(executionId)

      const rows = yield* db
        .select()
        .from(schema.processExecution)
        .where(eq(schema.processExecution.id, executionId))

      expect(rows).toHaveLength(1)
      expect(rows[0]?.processStateId).toBe(processState.processStateId)
    }),
  )

  it.effect(
    "rolls back the extra process state row on duplicate executionId insert",
    () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
        const sqlClient = yield* SqlClient.SqlClient
        const operations = yield* ProcessExecutionOperations
        const suffix = Date.now().toString(36)
        const orgUnitId = `ou-pe-dup-${suffix}`
        const processId = `prc-pe-dup-${suffix}`
        const stepId = `step-pe-dup-${suffix}`
        const stepPath = `/process-execution-dup-${suffix}/start`
        const executionId = `pex-postgres-dup-${suffix}`
        const startState = { hello: "world" }

        yield* ensureTestUser(suffix)

        yield* db.insert(schema.orgUnit).values({
          id: orgUnitId,
          name: `Process Execution Duplicate ${suffix}`,
          orgUnitLevel: "organisation",
          path: `/process-execution-dup-${suffix}`,
        })

        yield* db.insert(schema.process).values({
          id: processId,
          orgUnitId,
          name: `Process Duplicate ${suffix}`,
          path: `/process-execution-dup-${suffix}/process`,
          purpose: "Test duplicate process execution inserts",
        })

        yield* db.insert(schema.step).values({
          id: stepId,
          name: "Start",
          purpose: "Start step",
          processId,
          path: stepPath,
        })

        const initialProcessState = yield* operations.insertProcessState(
          processId,
          stepPath,
          startState,
        )

        yield* operations.insertProcessExecution(
          initialProcessState.processStateId,
          executionId,
        )

        const duplicateInsert = yield* Effect.either(
          sqlClient.withTransaction(
            Effect.gen(function* () {
              const duplicateProcessState =
                yield* operations.insertProcessState(
                  processId,
                  stepPath,
                  startState,
                )

              return yield* operations.insertProcessExecution(
                duplicateProcessState.processStateId,
                executionId,
              )
            }),
          ),
        )

        expect(duplicateInsert._tag).toBe("Left")

        const existingExecution =
          yield* operations.getProcessExecutionStartInfo(executionId)

        expect(existingExecution).toEqual({
          withoutWaiting: false,
          executionId,
          processId,
          stepId,
          startStepPath: stepPath,
          state: startState,
        })

        const processStateRows = yield* db
          .select({ id: schema.processState.id })
          .from(schema.processState)
          .where(eq(schema.processState.processId, processId))

        expect(processStateRows).toHaveLength(1)
      }),
  )
})
