import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigProvider, DateTime, Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { AuditPersistence } from "@pf/audit"
import { LocalAuditLive } from "@pf/audit/local"
import { createAuthenticationServer } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { makeTursoLive } from "@pf/layer-turso-local"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import { DatabaseTestFile } from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteAuditPersistenceLive,
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  SqliteSettingsQueriesLive,
  removeExpiredOAuthStorage,
} from "@pf/sqlite-operations"
import { expect, it } from "bun:test"

it("persists login and explicit logout intent through native local authentication and derives last login despite delivery and revocation failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "login-audit-"))
  const path = join(dir, "pf.db")
  const logs: string[] = []
  try {
    await Effect.runPromise(
      Effect.void.pipe(Effect.provide(DatabaseTestFile(path))),
    )
    const configuration = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: path }),
    )
    const database = TypedSqliteDrizzleLayer.pipe(
      Layer.provideMerge(makeTursoLive({ busy_timeout: 5000 })),
      Layer.provide(configuration),
    )
    const auditDatabase = TypedSqliteDrizzleLayer.pipe(
      Layer.fresh,
      Layer.provideMerge(
        makeTursoLive({ busy_timeout: 25, defaultQueryTimeout: 100 }),
      ),
      Layer.provide(configuration),
    )
    const audit = LocalAuditLive.pipe(
      Layer.provideMerge(SqliteAuditPersistenceLive),
      Layer.provide(auditDatabase),
    )
    const services = Layer.mergeAll(
      SqliteAuthenticationDatabaseLive,
      SqliteOpenAuthStorageServiceLive,
      SqliteSettingsQueriesLive,
      SqliteAuditPersistenceLive,
      FetchHttpClient.layer,
    ).pipe(Layer.provideMerge(database), Layer.merge(audit))
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const sql = yield* SqlClient.SqlClient
        // Ordinary OAuth storage must retain its own lock budget.
        expect(yield* db.all(drizzleSql`PRAGMA busy_timeout`)).toEqual([[5000]])
        const [org] = yield* db
          .insert(schema.orgUnit)
          .values({ name: "Root", path: "/", orgUnitLevel: "root" })
          .returning()
        const [user] = yield* db
          .insert(schema.user)
          .values({
            provider: "google",
            sub: "audit-human",
            createdAt: DateTime.makeUnsafe(0),
          })
          .returning()
        yield* db.insert(schema.providerUser).values({
          userId: user!.id,
          email: "audit@example.com",
          name: "Audit",
          firstName: "Audit",
          lastName: "",
          picture: "",
          locale: "en",
          orgUnitId: org!.id,
        })
        const queries = yield* SettingsQueries
        const initial = yield* queries.queryAllUsers(1, 10)
        expect(initial.items[0]!.lastLoggedIn.getTime()).toBe(0)
        const { app, runtime } = yield* createAuthenticationServer({
          dummyConfig: { email: "audit@example.com" },
          clients: [
            {
              id: "audit-client",
              redirectUris: ["https://client.example/callback"],
            },
          ],
        })
        const auth = createTestApp(app, { runtime })
        const client = createClient({
          issuer: "https://auth.example",
          clientID: "audit-client",
          fetch: (input, init) => Promise.resolve(auth.request(input, init)),
        })
        const login = Effect.gen(function* () {
          const { url, challenge } = yield* Effect.promise(() =>
            client.authorize("https://client.example/callback", "code", {
              pkce: true,
            }),
          )
          const start = yield* Effect.promise(() => auth.request(url))
          const response = yield* Effect.promise(() =>
            auth.request(start.headers.get("location")!, {
              headers: { cookie: start.headers.get("set-cookie")! },
            }),
          )
          expect(response.status).toBe(302)
          expect(
            new URL(response.headers.get("location")!).searchParams.get("code"),
          ).not.toBeNull()
          const code = new URL(
            response.headers.get("location")!,
          ).searchParams.get("code")!
          const result = yield* Effect.promise(() =>
            client.exchange(
              code,
              "https://client.example/callback",
              challenge.verifier,
            ),
          )
          if (result.err) throw result.err
          return result.tokens
        })
        // Drain a finite native statement that exceeds the delivery budget.
        yield* sql.unsafe(
          "CREATE TRIGGER slow_audit BEFORE INSERT ON pf_audit_event BEGIN SELECT sum(x) FROM (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT x FROM n); END",
        )
        yield* login
        expect(yield* db.select().from(schema.auditEvent)).toEqual([])
        expect(
          (yield* queries.queryAllUsers(
            1,
            10,
          )).items[0]!.lastLoggedIn.getTime(),
        ).toBe(0)
        expect(
          logs.some((log) =>
            log.includes("Audit delivery failed or timed out"),
          ),
        ).toBe(true)
        yield* sql.unsafe("DROP TRIGGER slow_audit")
        yield* login
        const events = yield* db.select().from(schema.auditEvent)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          auditKind: "login",
          auditDetails: {
            actorUserId: user!.id,
            authenticationMethod: "dummy",
          },
        })
        const observed = DateTime.toEpochMillis(events[0]!.occurredAt)
        expect(
          (yield* queries.queryAllUsers(
            1,
            10,
          )).items[0]!.lastLoggedIn.getTime(),
        ).toBe(observed)
        expect(
          (yield* queries.queryUserDetail(user!.id))!.lastLoggedIn.getTime(),
        ).toBe(observed)

        const logout = (token: string, path = "/oauth/logout") =>
          Effect.promise(() =>
            auth.request(`https://auth.example${path}`, {
              method: "POST",
              body: new URLSearchParams({ token, userId: "forged-actor" }),
            }),
          )
        const logoutEvents = Effect.gen(function* () {
          return (yield* db.select().from(schema.auditEvent)).filter(
            (event) => event.auditKind === "logout",
          )
        })
        const tokens = yield* login
        const lastLoginBeforeLogout = (yield* queries.queryUserDetail(
          user!.id,
        ))!.lastLoggedIn
        const beforeLogout = Date.now()
        // Fail actual database revocation, not an in-memory storage substitute.
        yield* sql.unsafe(
          "CREATE TRIGGER fail_revoke BEFORE DELETE ON pf_oauth_storage BEGIN SELECT RAISE(FAIL, 'revocation unavailable'); END",
        )
        for (let request = 0; request < 2; request++) {
          const response = yield* logout(tokens.refresh)
          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toEqual({
            success: true,
          })
        }
        const failedRevocationEvents = yield* logoutEvents
        expect(failedRevocationEvents).toHaveLength(2)
        expect(
          new Set(failedRevocationEvents.map((event) => event.id)).size,
        ).toBe(2)
        for (const event of failedRevocationEvents) {
          expect(event.auditDetails).toEqual({ actorUserId: user!.id })
          expect(
            DateTime.toEpochMillis(event.occurredAt),
          ).toBeGreaterThanOrEqual(beforeLogout - 1)
          expect(DateTime.toEpochMillis(event.occurredAt)).toBeLessThanOrEqual(
            Date.now(),
          )
        }
        yield* sql.unsafe("DROP TRIGGER fail_revoke")
        expect((yield* logout(tokens.refresh)).status).toBe(200)
        expect(yield* logoutEvents).toHaveLength(3)
        expect(
          (yield* queries.queryUserDetail(user!.id))!.lastLoggedIn,
        ).toEqual(lastLoginBeforeLogout)
        const revoked = yield* Effect.promise(() =>
          client.refresh(tokens.refresh),
        )
        expect(revoked.err).toBeDefined()

        // Missing, malformed, revoked, and forged subject prefixes establish no actor.
        for (const token of [
          "",
          "malformed",
          tokens.refresh,
          `${user!.id}:unknown-secret`,
        ])
          expect((yield* logout(token)).status).toBe(200)
        expect(yield* logoutEvents).toHaveLength(3)

        const generic = yield* login
        expect((yield* logout(generic.refresh, "/oauth/revoke")).status).toBe(
          200,
        )
        const expired = yield* login
        yield* sql.unsafe(
          "UPDATE pf_oauth_storage SET key_expiry = 2440587.5 WHERE oauth_key LIKE 'oauth:refresh%'",
        )
        expect((yield* logout(expired.refresh)).status).toBe(200)
        expect(yield* removeExpiredOAuthStorage).toBeGreaterThan(0)
        expect(yield* logoutEvents).toHaveLength(3)

        const deliveryFailure = yield* login
        yield* sql.unsafe(
          "CREATE TRIGGER fail_audit BEFORE INSERT ON pf_audit_event BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END",
        )
        const logStart = logs.length
        expect((yield* logout(deliveryFailure.refresh)).status).toBe(200)
        expect(yield* logoutEvents).toHaveLength(3)
        expect(
          (yield* Effect.promise(() => client.refresh(deliveryFailure.refresh)))
            .err,
        ).toBeDefined()
        const failureLogs = logs.slice(logStart).join("\n")
        expect(failureLogs).toContain('"type":"logout"')
        expect(failureLogs).toContain("Audit delivery failed or timed out")
        expect(failureLogs).not.toContain(deliveryFailure.refresh)
        expect(failureLogs).not.toContain("forged-actor")
        yield* sql.unsafe("DROP TRIGGER fail_audit")

        // Delayed delivery orders by occurrence, never insertion or logout time.
        const persistence = yield* AuditPersistence
        const newest = DateTime.toEpochMillis(
          DateTime.makeUnsafe("2030-01-03T00:00:00Z"),
        )
        for (const [id, type, occurredAt] of [
          ["newest", "login", newest],
          ["older-delivered-later", "login", newest - 86400000],
          ["logout", "logout", newest + 86400000],
        ] as const) {
          yield* persistence.insert({
            id,
            occurredAt,
            action:
              type === "login"
                ? {
                    type,
                    details: {
                      actorUserId: user!.id,
                      authenticationMethod: "dummy",
                    },
                  }
                : { type, details: { actorUserId: user!.id } },
          })
        }
        for (const id of ["machine-a", "machine-b"]) {
          yield* db.insert(schema.user).values({
            id,
            provider: "client_credentials",
            sub: id,
            createdAt: DateTime.makeUnsafe("2000-01-01T00:00:00Z"),
          })
        }
        const pages = []
        for (const page of [1, 2, 3, 4]) {
          const result = yield* queries.queryAllUsers(page, 1)
          expect(result.totalCount).toBe(3)
          pages.push(...result.items)
        }
        expect(pages.map((row) => row.id)).toEqual([
          user!.id,
          "machine-a",
          "machine-b",
        ])
        expect(pages.map((row) => row.lastLoggedIn.toISOString())).toEqual([
          "2030-01-03T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        ])
        expect(
          (yield* queries.queryUserDetail(
            user!.id,
          ))!.lastLoggedIn.toISOString(),
        ).toBe("2030-01-03T00:00:00.000Z")
      }).pipe(
        Effect.provide(services),
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              const message = JSON.stringify(entry.message)
              logs.push(message)
            }),
          ]),
        ),
      ),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)
