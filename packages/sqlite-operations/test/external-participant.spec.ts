import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import type { UserDetailsValue } from "@pf/graphql-db-operations"
import {
  ExternalParticipantOperations,
  InvalidExternalParticipantEmail,
  UserDetails,
} from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteExternalParticipantOperationsLive } from "../src/lib/external-participant"
import { describe, expect, it } from "bun:test"

describe("external-participant", () => {
  const fixedRequestTime = DateTime.makeUnsafe("2026-04-06T10:00:00.000Z")

  const TestLayer = Layer.provideMerge(
    Layer.mergeAll(
      SqliteExternalParticipantOperationsLive,
      Layer.succeed(RequestTime, fixedRequestTime),
      Layer.succeed(UserDetails, {
        by: "TEST_USER",
        id: "usr-test-external-participant",
      } as UserDetailsValue),
    ),
    DatabaseTest,
  )

  type TestRequirements = Layer.Success<typeof TestLayer>

  const runTest = <A, E>(test: Effect.Effect<A, E, TestRequirements>) =>
    Effect.runPromise(Effect.provide(test, TestLayer))

  it("upserts by normalized email against the partial unique index", () =>
    runTest(
      Effect.gen(function* () {
        const operations = yield* ExternalParticipantOperations
        const db = yield* TypedSqliteDrizzle

        const firstId = yield* operations.upsertByEmail(" Alice@Example.com ")
        const secondId = yield* operations.upsertByEmail("alice@example.com")

        expect(secondId).toBe(firstId)

        const rows = yield* db
          .select()
          .from(schema.externalParticipant)
          .where(eq(schema.externalParticipant.email, "alice@example.com"))

        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe(firstId)
      }),
    ))

  it("rejects invalid emails", () =>
    runTest(
      Effect.gen(function* () {
        const operations = yield* ExternalParticipantOperations

        const error = yield* Effect.flip(
          operations.upsertByEmail("not-an-email"),
        )

        expect(error).toBeInstanceOf(InvalidExternalParticipantEmail)
      }),
    ))
})
