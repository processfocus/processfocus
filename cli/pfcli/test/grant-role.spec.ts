import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AuthenticationDatabase } from "@pf/auth-api"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import * as schema from "@pf/drizzle-sqlite"
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
  loadPfcliCommand,
  runWithNodeContext,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

const randomSuffix = Math.random().toString(36).substring(2, 8)
const orgRoot = mkdtempSync(
  join(tmpdir(), `test-pfcli-grant-role-${randomSuffix}-`),
)
const dbPath = join(orgRoot, "db", "pf.db")

const baseEnv = {
  SQLITE_DATABASE_PATH: dbPath,
  OAUTH_ISSUER_URL: "http://localhost:4020",
  OAUTH_AUDIENCE: "graphql-api",
  GOOGLE_CLIENT_ID: process.env["GOOGLE_CLIENT_ID"] || "test-client-id",
  GOOGLE_CLIENT_SECRET:
    process.env["GOOGLE_CLIENT_SECRET"] || "test-client-secret",
  CI_PIPELINE_SECRET:
    process.env["CI_PIPELINE_SECRET"] || "test-pipeline-secret",
  GRAPHQL_SERVER_URL: "http://localhost:1",
}

useSerializedTestState()

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

const createCredentialsFile = (baseUrl: string) => {
  const credentialsPath = join(orgRoot, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl,
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        loginAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  return credentialsPath
}

type RunImport = (orgPath: string) => Effect.Effect<unknown>
type RunGrantRole = (options: {
  orgPath?: string
  rolePath: string
  email: string
  projectId?: string
  environmentId?: string
}) => Effect.Effect<unknown>

const makeAppLayer = (databasePath: string) => {
  const dbLayer = makePfcliSqlClientLayer(databasePath)
  const drizzleLayer = TypedSqliteDrizzleLayer.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )
  return Layer.mergeAll(
    SqliteAuthenticationDatabaseLive,
    SqliteOpenAuthStorageServiceLive,
  ).pipe(Layer.provide(drizzleLayer))
}

const makeDrizzleLayer = (databasePath: string) => {
  const dbLayer = makePfcliSqlClientLayer(databasePath)
  return TypedSqliteDrizzleLayer.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )
}

beforeAll(async () => {
  const { runImport } = await loadPfcliCommand<{ runImport: RunImport }>(
    "import",
  )
  await copySharedBuiltDemoArtifact(orgRoot)
  await withEnv(baseEnv, () => runWithNodeContext(runImport(orgRoot)))

  await runWithNodeContext(
    Effect.gen(function* () {
      const db = yield* AuthenticationDatabase
      const rootOrgUnit = yield* db.findRootOrgUnit()
      if (rootOrgUnit._tag === "None") {
        throw new Error("No root org unit found after import")
      }
      yield* db.createProviderUser({
        provider: "google",
        sub: "google-123",
        email: "ci@example.com",
        name: "CI User",
        firstName: "CI",
        lastName: "User",
        picture: "",
        locale: "en",
        orgUnitId: rootOrgUnit.value.id,
      })
    }).pipe(Effect.provide(makeAppLayer(dbPath))),
  )
}, 120_000)

afterEach(() => {
  process.exitCode = 0
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  if (originalCredPath === undefined) {
    delete process.env["PFCLI_CREDENTIALS_PATH"]
  } else {
    process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
  }
})

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`
    if (existsSync(file)) unlinkSync(file)
  }
  rmSync(orgRoot, { recursive: true, force: true })
})

describe("pfcli grant role", () => {
  it("grants a role and reports already had role on repeat", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output: firstOutput } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/Administrator",
            email: "ci@example.com",
          }),
        ),
      ),
    )

    const { output: secondOutput } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/Administrator",
            email: "ci@example.com",
          }),
        ),
      ),
    )

    expect(firstOutput).toMatch(/granted role/)
    expect(secondOutput).toMatch(/already had role/)
  }, 60_000)

  it("fails when provider user does not exist", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/Administrator",
            email: "nonexistent@example.com",
          }),
        ),
      ),
    )

    expect(output).toMatch(/provider user not found/)
  }, 60_000)

  it("fails when role does not exist", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/NonExistentRole",
            email: "ci@example.com",
          }),
        ),
      ),
    )

    expect(output).toMatch(/role not found/)
  }, 60_000)

  it("normalizes role path by prepending /", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "Employee",
            email: "ci@example.com",
          }),
        ),
      ),
    )

    expect(output).toMatch(/granted role/)
  }, 60_000)

  it("normalizes email by trimming and lowercasing", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/finance/Manager",
            email: "  CI@Example.COM  ",
          }),
        ),
      ),
    )

    expect(output).toMatch(/granted role/)
  }, 60_000)

  it("works with SQLITE_DATABASE_PATH env var", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output } = await withEnv(
      { ...baseEnv, SQLITE_DATABASE_PATH: dbPath },
      () =>
        captureStdout(() =>
          runWithNodeContext(
            runGrantRole({
              rolePath: "/operations/Facilities",
              email: "ci@example.com",
            }),
          ),
        ),
    )

    expect(output).toMatch(/granted role/)
  }, 60_000)

  it("fails when no database path can be resolved", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const prevExitCode = process.exitCode

    try {
      const { output } = await withEnv(
        { SQLITE_DATABASE_PATH: "", PF_ORG: "" },
        () =>
          captureStdout(() =>
            runWithNodeContext(
              runGrantRole({
                rolePath: "/Administrator",
                email: "ci@example.com",
              }),
            ),
          ),
      )

      expect(output).toMatch(/Database path not configured/)
    } finally {
      process.exitCode = prevExitCode ?? 0
    }
  })

  it("uses remote GraphQL mode when --project and --env are provided", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    process.env["PFCLI_CREDENTIALS_PATH"] =
      createCredentialsFile("http://mocked.test")

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: Record<string, unknown>
      }

      expect(body.query).toContain("grantProjectUserRole")
      expect(body.variables).toEqual({
        projectId: "0000-1000-1000",
        environmentId: "bdb",
        rolePath: "Administrator",
        email: "  CI@Example.COM  ",
      })

      return new Response(
        JSON.stringify({
          data: {
            grantProjectUserRole: {
              success: true,
              email: "ci@example.com",
              rolePath: "/Administrator",
              alreadyHadRole: false,
              error: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            rolePath: "Administrator",
            email: "  CI@Example.COM  ",
            projectId: "0000-1000-1000",
            environmentId: "bdb",
          }),
        ),
      ),
    )

    expect(output).toMatch(
      /granted role: ci@example.com granted \/Administrator/,
    )
  })

  it("fails fast when only one remote selector is provided", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            rolePath: "/Administrator",
            email: "ci@example.com",
            projectId: "0000-1000-1000",
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toMatch(/requires both --project and --env together/)
  })

  it("rejects positional org-path in remote mode", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/Administrator",
            email: "ci@example.com",
            projectId: "0000-1000-1000",
            environmentId: "bdb",
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toMatch(/does not accept positional org-path/)
  })

  it("surfaces remote auth failures from GraphQL", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    process.env["PFCLI_CREDENTIALS_PATH"] =
      createCredentialsFile("http://mocked.test")

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [
            { message: "Not authorized to access grantProjectUserRole" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            rolePath: "/Administrator",
            email: "ci@example.com",
            projectId: "0000-1000-1000",
            environmentId: "bdb",
          }),
        ),
      ),
    )

    expect(output).toMatch(
      /GraphQL error: Not authorized to access grantProjectUserRole/,
    )
  })

  it("surfaces remote timeout failures from GraphQL", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    process.env["PFCLI_CREDENTIALS_PATH"] =
      createCredentialsFile("http://mocked.test")

    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) =>
      originalSetTimeout(handler, 0)) as typeof setTimeout

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!(signal instanceof AbortSignal)) {
          reject(new Error("Expected abort signal"))
          return
        }

        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"))
        })
      })) as typeof fetch

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            rolePath: "/Administrator",
            email: "ci@example.com",
            projectId: "0000-1000-1000",
            environmentId: "bdb",
          }),
        ),
      ),
    )

    expect(output).toMatch(/GraphQL request timed out after 30 seconds/)
  })
})

describe("grant-role DB primitives", () => {
  it("reactivates a soft-deleted provider user role", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const rolePath = "/procurement/Manager"

    const { output: firstOutput } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath,
            email: "ci@example.com",
          }),
        ),
      ),
    )

    expect(firstOutput).toMatch(/granted role/)

    await runWithNodeContext(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        const providerUser = yield* db
          .select({ id: schema.providerUser.id })
          .from(schema.providerUser)
          .where(eq(schema.providerUser.email, "ci@example.com"))
          .limit(1)

        const role = yield* db
          .select({ id: schema.role.id })
          .from(schema.role)
          .where(eq(schema.role.path, rolePath))
          .limit(1)

        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: true, updatedBy: "TEST" })
          .where(
            and(
              eq(schema.providerUserRole.providerUserId, providerUser[0]!.id),
              eq(schema.providerUserRole.roleId, role[0]!.id),
              eq(schema.providerUserRole._deleted, false),
            ),
          )
      }).pipe(Effect.provide(makeDrizzleLayer(dbPath))),
    )

    const { output } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath,
            email: "ci@example.com",
          }),
        ),
      ),
    )

    expect(output).toMatch(/granted role/)
  }, 60_000)

  it("grantProviderUserRole is idempotent via SettingsQueries", async () => {
    const { runGrantRole } = await loadPfcliCommand<{
      runGrantRole: RunGrantRole
    }>("grant-role")

    const { output: output1 } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/hr/Manager",
            email: "ci@example.com",
          }),
        ),
      ),
    )
    expect(output1).toMatch(/granted role/)

    const { output: output2 } = await withEnv(baseEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runGrantRole({
            orgPath: orgRoot,
            rolePath: "/hr/Manager",
            email: "ci@example.com",
          }),
        ),
      ),
    )
    expect(output2).toMatch(/already had role/)
  }, 60_000)
})
