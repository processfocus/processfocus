import { expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { AuditPersistence } from "@pf/audit"
import * as schema from "@pf/drizzle-postgres"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { PostgresAuditPersistenceLive } from "../src/lib/audit"
import { PostgresSettingsQueriesLive } from "../src/lib/settings-queries"
import { PostgresTest, TypedPostgresDrizzle } from "./postgres-test"

const TestLayer = Layer.mergeAll(
  PostgresAuditPersistenceLive,
  PostgresSettingsQueriesLive,
).pipe(Layer.provideMerge(PostgresTest))

it.layer(TestLayer, { timeout: "60 seconds" })(
  "PostgreSQL last-login projection",
  (it) => {
    it.effect(
      "decodes aggregated JSON actor evidence and preserves fallback and pagination",
      () =>
        Effect.gen(function* () {
          const db = yield* TypedPostgresDrizzle
          const queries = yield* SettingsQueries
          const persistence = yield* AuditPersistence
          for (const id of ["human", "machine-a", "machine-b"]) {
            yield* db.insert(schema.user).values({
              id,
              provider: id === "human" ? "google" : "client_credentials",
              sub: id,
              createdAt: DateTime.makeUnsafe("2000-01-01T00:00:00Z"),
            })
          }
          expect(
            (yield* queries.queryUserDetail(
              "human",
            ))!.lastLoggedIn.toISOString(),
          ).toBe("2000-01-01T00:00:00.000Z")
          for (const [id, type, date] of [
            ["latest", "login", "2026-01-03T00:00:00Z"],
            ["delayed", "login", "2026-01-02T00:00:00Z"],
            ["logout", "logout", "2026-01-04T00:00:00Z"],
          ] as const) {
            yield* persistence.insert({
              id,
              occurredAt: DateTime.toEpochMillis(DateTime.makeUnsafe(date)),
              action:
                type === "login"
                  ? {
                      type,
                      details: {
                        actorUserId: "human",
                        authenticationMethod: "oauth",
                      },
                    }
                  : { type, details: { actorUserId: "human" } },
            })
          }
          const items = []
          for (const page of [1, 2, 3, 4]) {
            const result = yield* queries.queryAllUsers(page, 1)
            expect(result.totalCount).toBe(3)
            items.push(...result.items)
          }
          expect(items.map((row) => row.id)).toEqual([
            "human",
            "machine-a",
            "machine-b",
          ])
          expect(items.map((row) => row.lastLoggedIn.toISOString())).toEqual([
            "2026-01-03T00:00:00.000Z",
            "2000-01-01T00:00:00.000Z",
            "2000-01-01T00:00:00.000Z",
          ])
          expect(
            (yield* queries.queryUserDetail("human"))!.lastLoggedIn,
          ).toEqual(items[0]!.lastLoggedIn)
        }),
    )
  },
)
