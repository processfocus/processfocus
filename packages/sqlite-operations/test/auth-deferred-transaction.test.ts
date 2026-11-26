import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { LocalAuditLive } from "@pf/audit/local"
import { createAuthenticationServer } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { makeTursoCloudLive } from "@pf/layer-turso-cloud"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import {
  SqliteAuditPersistenceLive,
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "../src/index"
import { expect, it } from "bun:test"

const batch = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({ stmt: Schema.Struct({ sql: Schema.String }) }),
  ),
})
const pipeline = Schema.Struct({
  batch: Schema.optional(batch),
  requests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        sql: Schema.optional(Schema.String),
        batch: Schema.optional(batch),
      }),
    ),
  ),
})

// Unlike the local default, the real AWS adapter starts immediate transactions.
// A separate writer held throughout authentication makes a missing opt-in fail.
it.skipIf(!Bun.which("sqld"))(
  "unchanged dummy authentication commits under a competing writer using the AWS database adapter",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-deferred-"))
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() })
    const backend = `http://127.0.0.1:${reserve.port}`
    reserve.stop(true)
    const daemon = Bun.spawn(
      ["sqld", "--db-path", directory, "--http-listen-addr", backend.slice(7)],
      { stdout: "ignore", stderr: "ignore" },
    )
    const writerRuntime = ManagedRuntime.make(
      makeTursoCloudLive().pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: backend }),
          ),
        ),
      ),
    )
    const writer = {
      execute: (statement: string) =>
        writerRuntime.runPromise(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)),
        ),
    }
    let armed = false
    let locked = false
    let committedUnderLock = false
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text()
        const decoded = Schema.decodeUnknownSync(pipeline)(JSON.parse(body))
        const statements = [
          ...(decoded.batch?.steps.map((s) => s.stmt.sql) ?? []),
          ...(decoded.requests ?? []).flatMap(
            (r) =>
              r.batch?.steps.map((s) => s.stmt.sql) ?? (r.sql ? [r.sql] : []),
          ),
        ]
        if (armed && statements.some((s) => s.startsWith("BEGIN"))) {
          armed = false
          await writer.execute("BEGIN IMMEDIATE")
          locked = true
        }
        const response = await fetch(backend + new URL(request.url).pathname, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
          },
          body,
        })
        if (locked && statements.includes("COMMIT")) {
          // The competing transaction is still writable when authentication commits.
          await writer.execute(
            "UPDATE pf_org_unit SET name = 'Writer retained lock'",
          )
          committedUnderLock = true
          await writer.execute("ROLLBACK")
          locked = false
        }
        return response
      },
    })
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await fetch(backend)
          break
        } catch {
          await Bun.sleep(20)
        }
      }
      for (const migration of readMigrationFiles({
        migrationsFolder: join(import.meta.dir, "../../drizzle-sqlite/drizzle"),
      }))
        for (const statement of migration.sql)
          if (statement.trim()) await writer.execute(statement)
      const cloud = makeTursoCloudLive().pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SQLITE_DATABASE_PATH: `http://127.0.0.1:${proxy.port}`,
            }),
          ),
        ),
      )
      const database = TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(cloud))
      const services = Layer.mergeAll(
        SqliteAuthenticationDatabaseLive,
        SqliteOpenAuthStorageServiceLive,
        LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
      ).pipe(Layer.provideMerge(database))
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const sql = yield* SqlClient.SqlClient
          const [org] = yield* db
            .insert(schema.orgUnit)
            .values({ name: "Root", path: "/", orgUnitLevel: "root" })
            .returning()
          const [user] = yield* db
            .insert(schema.user)
            .values({ provider: "google", sub: "existing" })
            .returning()
          yield* db.insert(schema.providerUser).values({
            userId: user!.id,
            email: "existing@example.com",
            name: "Existing",
            firstName: "Existing",
            lastName: "",
            picture: "",
            locale: "en",
            orgUnitId: org!.id,
          })
          const { app, runtime } = yield* createAuthenticationServer({
            dummyConfig: { email: "existing@example.com" },
            clients: [
              { id: "test", redirectUris: ["https://client.example/callback"] },
            ],
          })
          const auth = createTestApp(app, { runtime })
          const client = createClient({
            issuer: "https://auth.example",
            clientID: "test",
            fetch: (input, init) => Promise.resolve(auth.request(input, init)),
          })
          const { url, challenge } = yield* Effect.promise(() =>
            client.authorize("https://client.example/callback", "code", {
              pkce: true,
            }),
          )
          const start = yield* Effect.promise(() => auth.request(url))
          armed = true
          const callback = yield* Effect.promise(() =>
            auth.request(start.headers.get("location")!, {
              headers: { cookie: start.headers.get("set-cookie")! },
            }),
          )
          expect(committedUnderLock).toBe(true)
          const code = new URL(
            callback.headers.get("location")!,
          ).searchParams.get("code")
          expect(code).not.toBeNull()
          const result = yield* Effect.promise(() =>
            client.exchange(
              code!,
              "https://client.example/callback",
              challenge.verifier,
            ),
          )
          expect(result.err).toBe(false)
          const audits = yield* db.select().from(schema.auditEvent)
          expect(audits).toHaveLength(1)
          expect(audits[0]!.auditDetails).toEqual({
            actorUserId: user!.id,
            authenticationMethod: "dummy",
          })
          // Audit persistence and token writes ran after the read transaction released
          // its lease. Subsequent ordinary transactions still write successfully.
          yield* sql.withTransaction(
            sql.unsafe("UPDATE pf_org_unit SET name = 'Usable'"),
          )
          expect((yield* db.select().from(schema.orgUnit))[0]!.name).toBe(
            "Usable",
          )
        }).pipe(
          Effect.provide(services),
          Effect.provide(FetchHttpClient.layer),
        ),
      )
    } finally {
      if (locked) await writer.execute("ROLLBACK").catch(() => {})
      await writerRuntime.dispose()
      proxy.stop(true)
      daemon.kill()
      await daemon.exited
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
