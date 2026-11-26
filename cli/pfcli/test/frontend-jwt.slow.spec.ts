import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import {
  AuthenticationDatabase,
  AuthenticationDelegationIdentityFactsLive,
  buildFrontendClients,
  createAuthenticationServer,
} from "@pf/auth-api"
import { getAudience, getClientId, subjects } from "@pf/auth-session"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import {
  DelegationCredentialServiceLive,
  DelegationDatabase,
} from "@pf/delegation"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "@pf/sqlite-operations"
import { makePfcliSqlClientLayer } from "../src/utils/local-database-layer"
import {
  captureStdout,
  copySharedBuiltDemoArtifact,
  copySharedImportedDemoDatabase,
  loadPfcliCommand,
  readStoredFrontendJwt,
  runWithNodeContext,
  runWithNodeContextExit,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"

const randomSuffix = Math.random().toString(36).substring(2, 8)
const orgRoot = mkdtempSync(
  join(tmpdir(), `test-pfcli-jwt-org-${randomSuffix}-`),
)
const dbPath = join(orgRoot, "db", "pf.db")

useSerializedTestState()

const baseEnv = {
  SQLITE_DATABASE_PATH: dbPath,
  OAUTH_ISSUER_URL: "http://localhost:4020",
  OAUTH_AUDIENCE: "graphql-api",
  OAUTH_CLIENT_ID: undefined,
  FRONTEND_JWT_TOKEN: undefined,
  GOOGLE_CLIENT_ID: process.env["GOOGLE_CLIENT_ID"] || "test-client-id",
  GOOGLE_CLIENT_SECRET:
    process.env["GOOGLE_CLIENT_SECRET"] || "test-client-secret",
  CI_PIPELINE_SECRET:
    process.env["CI_PIPELINE_SECRET"] || "test-pipeline-secret",
  // Suppress graphql server notification (no server running)
  GRAPHQL_SERVER_URL: "http://localhost:1",
}

type RunImport = (orgPath: string) => Effect.Effect<unknown>
type RunMigrate = (orgPath: string) => Effect.Effect<unknown>
type RunGetFrontendJwt = (orgPath: string) => Effect.Effect<unknown>
type RunRefreshFrontendJwt = (orgPath: string) => Effect.Effect<unknown>

const decodeIssuedAt = (token: string): number => {
  const payload = token.split(".")[1]
  if (!payload) {
    throw new Error("JWT payload missing")
  }

  const claims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  )
  if (
    typeof claims !== "object" ||
    claims === null ||
    !("iat" in claims) ||
    typeof claims.iat !== "number"
  ) {
    throw new Error("JWT iat claim missing")
  }

  return claims.iat
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`
    if (existsSync(file)) unlinkSync(file)
  }
  rmSync(orgRoot, { recursive: true, force: true })
})

describe("pfcli frontend JWT integration", () => {
  // Shared state: initial import runs once and seeds the database
  // for all dependent tests in this describe block.
  let initialToken: string

  beforeAll(async () => {
    await copySharedBuiltDemoArtifact(orgRoot)
    await copySharedImportedDemoDatabase(dbPath)

    const token = await withEnv(baseEnv, () => readStoredFrontendJwt(orgRoot))

    if (!token) {
      throw new Error("Initial import did not create a frontend JWT")
    }

    initialToken = token
  }, 120_000)

  it("get-frontend-jwt returns a valid JWT created by import", async () => {
    const { runGetFrontendJwt } = await loadPfcliCommand<{
      runGetFrontendJwt: RunGetFrontendJwt
    }>("get-frontend-jwt")
    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() => runWithNodeContext(runGetFrontendJwt(orgRoot))),
    )

    expect(output.length).toBeGreaterThan(0)
    expect(output.split(".")).toHaveLength(3)
  })

  it("second import skips JWT creation and preserves existing token", async () => {
    const { runImport } = await loadPfcliCommand<{ runImport: RunImport }>(
      "import",
    )
    const secondImportOrgRoot = mkdtempSync(
      join(tmpdir(), "test-pfcli-jwt-reimport-"),
    )

    try {
      await copySharedBuiltDemoArtifact(secondImportOrgRoot)
      const { output } = await withEnv(
        {
          ...baseEnv,
          SQLITE_DATABASE_PATH: dbPath,
        },
        () =>
          captureStdout(() =>
            runWithNodeContext(runImport(secondImportOrgRoot)),
          ),
      )

      expect(output).toContain("Frontend JWT already exists")
    } finally {
      rmSync(secondImportOrgRoot, { recursive: true, force: true })
    }

    const tokenAfter = await withEnv(baseEnv, () =>
      readStoredFrontendJwt(orgRoot),
    )
    expect(tokenAfter).toBe(initialToken)
  }, 60_000)

  it("refresh-frontend-jwt regenerates the token", async () => {
    const { runRefreshFrontendJwt } = await loadPfcliCommand<{
      runRefreshFrontendJwt: (
        orgPath: string,
        dependencies?: { readonly issuedAtUnixSeconds?: () => number },
      ) => Effect.Effect<unknown>
    }>("refresh-frontend-jwt")
    const initialIssuedAt = decodeIssuedAt(initialToken)
    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runRefreshFrontendJwt(orgRoot, {
            issuedAtUnixSeconds: () => initialIssuedAt + 1,
          }),
        ),
      ),
    )

    const tokenAfter = await withEnv(baseEnv, () =>
      readStoredFrontendJwt(orgRoot),
    )
    expect(output).toContain("Frontend JWT refreshed")
    expect(tokenAfter).toBeDefined()
    if (!tokenAfter) {
      throw new Error("Expected refreshed frontend JWT to be present")
    }
    expect(tokenAfter.split(".")).toHaveLength(3)
    expect(tokenAfter).not.toBe(initialToken)
    expect(decodeIssuedAt(tokenAfter)).toBe(initialIssuedAt + 1)
  })

  for (const configuration of ["env", "jwt", "production"] as const) {
    it(`round-trips pfcli ${configuration} identity/audience through registration, delegation and CLI refresh`, async () => {
      const { runImport } = await loadPfcliCommand<{ runImport: RunImport }>(
        "import",
      )
      const { runRefreshFrontendJwt } = await loadPfcliCommand<{
        runRefreshFrontendJwt: RunRefreshFrontendJwt
      }>("refresh-frontend-jwt")
      const { runGetFrontendJwt } = await loadPfcliCommand<{
        runGetFrontendJwt: RunGetFrontendJwt
      }>("get-frontend-jwt")
      const clientId = `local-${configuration}-frontend`
      const audience = `local-${configuration}-api`
      const issuer = "http://localhost:4020"
      const root = mkdtempSync(join(tmpdir(), "pfcli-configured-jwt-"))
      const databasePath = join(root, "db", "pf.db")
      try {
        await copySharedBuiltDemoArtifact(root)
        await copySharedImportedDemoDatabase(databasePath)
        await withEnv(
          {
            ...baseEnv,
            SQLITE_DATABASE_PATH: databasePath,
            NODE_ENV:
              configuration === "production" ? "production" : "development",
            OPENAUTH_CLIENTS:
              configuration === "production"
                ? JSON.stringify(
                    ["other-client", clientId].map((id) => ({
                      id,
                      audience,
                      redirectUris: ["http://localhost/api/auth/callback"],
                      tokenEndpointAuthMethod: "client_jwt",
                    })),
                  )
                : undefined,
            OAUTH_CLIENT_ID: clientId,
            OAUTH_AUDIENCE: audience,
          },
          async () => {
            await captureStdout(() => runWithNodeContext(runImport(root)))
            const read = async () =>
              (
                await captureStdout(() =>
                  runWithNodeContext(runGetFrontendJwt(root)),
                )
              ).output
            const imported = await read()
            if (configuration !== "env") {
              // The supplied credential must win over conflicting env config,
              // not an env audience deliberately made equal to the JWT audience.
              process.env["FRONTEND_JWT_TOKEN"] = imported
              process.env["OAUTH_CLIENT_ID"] = "wrong-env-client"
              process.env["OAUTH_AUDIENCE"] = "wrong-env-audience"
            }
            const reimportRoot = join(root, "reimport")
            await copySharedBuiltDemoArtifact(reimportRoot)
            const reimport = await captureStdout(() =>
              runWithNodeContext(runImport(reimportRoot)),
            )
            expect(reimport.output).toContain("Frontend JWT already exists")
            expect(await read()).toBe(imported)
            await captureStdout(() =>
              runWithNodeContext(runRefreshFrontendJwt(root)),
            )
            const bearer = await read()
            const configLayer = ConfigProvider.layer(
              ConfigProvider.fromEnvRecord(process.env),
            )
            const clients = await Effect.runPromise(
              buildFrontendClients().pipe(Effect.provide(configLayer)),
            )
            // Match the launcher: resolve the stored token before starting the frontend.
            process.env["FRONTEND_JWT_TOKEN"] = bearer
            expect(getClientId()).toBe(clientId)
            expect(getAudience()).toBe(audience)
            expect(clients).toMatchObject(
              configuration === "production"
                ? []
                : [
                    {
                      id: clientId,
                      audience,
                      tokenEndpointAuthMethod: "client_jwt",
                    },
                  ],
            )

            const storage = SqliteOpenAuthStorageServiceLive.pipe(
              Layer.provideMerge(TypedSqliteDrizzleLayer),
              Layer.provideMerge(makePfcliSqlClientLayer(databasePath)),
              Layer.provide(makeDatabaseConfigLayer(databasePath)),
            )
            const base = Layer.mergeAll(
              LocalAuditLive.pipe(
                Layer.provide(SqliteAuditPersistenceLive),
                Layer.provide(storage),
              ),
              storage,
              AuthenticationDelegationIdentityFactsLive.pipe(
                Layer.provideMerge(SqliteAuthenticationDatabaseLive),
                Layer.provide(storage),
              ),
              FetchHttpClient.layer,
            )
            await Effect.runPromise(
              Effect.gen(function* () {
                const db = yield* TypedSqliteDrizzle
                const [unit] = yield* db.select().from(schema.orgUnit).limit(1)
                if (!unit) throw new Error("Missing imported org unit")
                const authDb = yield* AuthenticationDatabase
                const owner = yield* authDb.createProviderUser({
                  email: "config-regression@example.com",
                  name: "Config Regression",
                  firstName: "Config",
                  lastName: "Regression",
                  picture: "",
                  locale: "en",
                  provider: "passkey",
                  sub: "config-regression",
                  orgUnitId: unit.id,
                })
                yield* db.insert(schema.oauthProvider).values({
                  providerName: "config-regression",
                  providerConfig: { delegatedAccess: true },
                })
                const store = yield* DelegationDatabase
                const ownerId = yield* store.findOwnerId(owner.id)
                if (Option.isNone(ownerId)) throw new Error("Missing owner")
                const [role] = yield* db.select().from(schema.role).limit(1)
                if (!role) throw new Error("Missing imported role")
                yield* db
                  .insert(schema.providerUserRole)
                  .values({ providerUserId: ownerId.value, roleId: role.id })
                const secret = `pfds_${"b".repeat(43)}`
                yield* store.claimName({
                  id: "dlg-config",
                  ownerId: ownerId.value,
                  name: "config",
                })
                const now = yield* DateTime.now
                yield* store.insertGeneration({
                  id: "dsg-config",
                  delegationId: "dlg-config",
                  verifier: createHash("sha256")
                    .update(secret)
                    .digest("base64url"),
                  issuedAt: now,
                  expiresAt: DateTime.addDuration(now, "1 hour"),
                })
                const { app, runtime } = yield* createAuthenticationServer({
                  clients,
                })
                const server = createTestApp(app, { runtime })
                const tokens = Schema.decodeUnknownSync(
                  Schema.Struct({
                    access_token: Schema.String,
                    refresh_token: Schema.String,
                  }),
                )
                const exchanged = yield* Effect.promise(() =>
                  server.request(`${issuer}/oauth/delegation`, {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${bearer}`,
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({ secret }),
                  }),
                )
                expect(
                  exchanged.status,
                  exchanged.status === 200
                    ? ""
                    : yield* Effect.promise(() => exchanged.text()),
                ).toBe(200)
                const browser = tokens(
                  yield* Effect.promise(() => exchanged.json()),
                )
                const client = createClient({
                  issuer,
                  clientID: clientId,
                  fetch: (input, init) =>
                    Promise.resolve(server.request(input, init)),
                })
                const verified = yield* Effect.promise(() =>
                  client.verify(subjects, browser.access_token, { audience }),
                )
                expect(verified.err).toBeUndefined()
                const refreshed = yield* Effect.promise(() =>
                  server.request(`${issuer}/oauth/token`, {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${bearer}`,
                      "content-type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      grant_type: "refresh_token",
                      refresh_token: browser.refresh_token,
                      scope: "cli",
                    }).toString(),
                  }),
                )
                expect(refreshed.status).toBe(200)
                const cli = tokens(
                  yield* Effect.promise(() => refreshed.json()),
                )
                const checked = yield* Effect.promise(() =>
                  client.verify(subjects, cli.access_token, { audience }),
                )
                expect(checked.err).toBeUndefined()
              }).pipe(
                Effect.provide(
                  DelegationCredentialServiceLive.pipe(
                    Layer.provideMerge(base),
                  ),
                ),
                Effect.provide(configLayer),
              ),
            )
          },
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)
  }

  it("refresh-frontend-jwt fails gracefully with bad org path", async () => {
    const { runRefreshFrontendJwt } = await loadPfcliCommand<{
      runRefreshFrontendJwt: RunRefreshFrontendJwt
    }>("refresh-frontend-jwt")
    const exit = await withEnv(
      {
        // Empty string overrides .env loading but is falsy, so
        // resolveDatabasePath falls through to the (nonexistent) org path.
        SQLITE_DATABASE_PATH: "",
      },
      () => runWithNodeContextExit(runRefreshFrontendJwt("/nonexistent/org")),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("get-frontend-jwt fails gracefully on empty database", async () => {
    const { runMigrate } = await loadPfcliCommand<{ runMigrate: RunMigrate }>(
      "migrate",
    )
    const { runGetFrontendJwt } = await loadPfcliCommand<{
      runGetFrontendJwt: RunGetFrontendJwt
    }>("get-frontend-jwt")
    const emptyOrgRoot = mkdtempSync(join(tmpdir(), "test-pfcli-jwt-empty-"))
    const emptyDbPath = join(emptyOrgRoot, "db", "pf.db")

    try {
      await withEnv({ SQLITE_DATABASE_PATH: emptyDbPath }, async () => {
        await runWithNodeContext(runMigrate(emptyOrgRoot))

        const error = await Effect.runPromise(
          runGetFrontendJwt(emptyOrgRoot).pipe(Effect.flip),
        )

        expect(String(error)).toContain("No frontend JWT found")
      })
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${emptyDbPath}${suffix}`
        if (existsSync(file)) unlinkSync(file)
      }
      rmSync(emptyOrgRoot, { recursive: true, force: true })
    }
  }, 60_000)
})

import { LocalAuditLive } from "@pf/audit/local"
import { SqliteAuditPersistenceLive } from "@pf/sqlite-operations"
