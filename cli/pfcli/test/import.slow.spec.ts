import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { connect } from "@tursodatabase/database"
import { Cause, Effect, Exit, Option } from "effect"
import {
  DEMO_ORG,
  copySharedBuiltDemoArtifact,
  copySharedImportedDemoDatabase,
  loadPfcliCommand,
  readStoredFrontendJwtFromDatabasePath,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")
// CI can take longer to build/load demo artifacts than local development.
const IMPORT_TEST_TIMEOUT_MS = 30_000

useSerializedTestState()

type ImportCycleOptions = {
  readonly runMigrations: boolean
  readonly ensureFrontendJwt: boolean
}

type RunImport = (
  orgPath: string,
  options?: Partial<ImportCycleOptions>,
) => Effect.Effect<unknown>
type RunBuild = (orgPath: string, outputDir?: string) => Effect.Effect<unknown>
const loadRunImport = async (): Promise<RunImport> => {
  const module = await loadPfcliCommand<{
    runImport: RunImport
  }>("import")
  return module.runImport
}

const tempPaths: string[] = []
const originalFetch = globalThis.fetch

const createTempOrgFromSharedBuild = async (
  options: { includeCustomMigrations?: boolean } = {},
) => {
  const orgRoot = mkdtempSync(join(tmpdir(), "pfcli-import-org-"))
  await copySharedBuiltDemoArtifact(orgRoot, options)

  tempPaths.push(orgRoot)
  return orgRoot
}

const createProcessFreeArtifact = async () => {
  const orgRoot = mkdtempSync(join(tmpdir(), "pfcli-import-process-free-"))
  tempPaths.push(orgRoot)
  cpSync(DEMO_ORG, orgRoot, { recursive: true })
  writeFileSync(
    join(orgRoot, "src", "index.ts"),
    `import { Organisation } from "@pf/process"

export const org = new Organisation({
  name: "Process Free Org",
})
`,
  )

  const { runBuild } = await loadPfcliCommand<{ runBuild: RunBuild }>("build")
  await Effect.runPromise(Effect.provide(runBuild(orgRoot), NodeServices.layer))

  for (const entry of readdirSync(orgRoot)) {
    if (entry !== "dist") {
      rmSync(join(orgRoot, entry), { recursive: true, force: true })
    }
  }
  symlinkSync(
    join(WORKSPACE_ROOT, "cli/pfcli/node_modules"),
    join(orgRoot, "node_modules"),
    "dir",
  )

  return orgRoot
}

const createStaleNxWorkspace = () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pfcli-stale-workspace-"))
  const localPackageSourceRoot = join(
    workspaceRoot,
    "packages/layer-turso-local/src",
  )
  const cloudPackageSourceRoot = join(
    workspaceRoot,
    "packages/layer-turso-cloud/src",
  )
  mkdirSync(localPackageSourceRoot, { recursive: true })
  mkdirSync(cloudPackageSourceRoot, { recursive: true })
  writeFileSync(
    join(localPackageSourceRoot, "index.ts"),
    "export const makeTursoLive = () => ({ build: undefined })\n",
  )
  writeFileSync(
    join(cloudPackageSourceRoot, "index.ts"),
    "export const TursoCloudLive = { build: undefined }\n",
  )
  tempPaths.push(workspaceRoot)
  return workspaceRoot
}

const getFailureCauseMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isFailure(exit)) {
    const errorOption = Cause.findErrorOption(exit.cause)

    if (Option.isSome(errorOption)) {
      const { value } = errorOption

      if (
        typeof value === "object" &&
        value !== null &&
        "cause" in value &&
        value.cause instanceof Error
      ) {
        return value.cause.message
      }

      return value instanceof Error ? value.message : String(value)
    }
  }

  return ""
}

const decodeJwtClaims = (token: string) => {
  const payload = token.split(".")[1]
  if (!payload) {
    throw new Error("JWT payload missing")
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    iss?: string
    aud?: string | string[]
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch

  delete process.env["SQLITE_DATABASE_PATH"]
  delete process.env["TURSO_AUTH_TOKEN"]
  delete process.env["GOOGLE_CLIENT_ID"]
  delete process.env["GOOGLE_CLIENT_SECRET"]
  delete process.env["OAUTH_ISSUER_URL"]
  delete process.env["GRAPHQL_SERVER_URL"]
  delete process.env["PF_IMPORT_MODE"]
  delete process.env["PF_IMPORT_SKIP_FRONTEND_JWT"]
  delete process.env["PF_IMPORT_SKIP_MIGRATIONS"]
  delete process.env["PF_ORG"]

  for (const tempPath of tempPaths) {
    rmSync(tempPath, { recursive: true, force: true })
  }
  tempPaths.length = 0
})

describe("pfcli import", () => {
  it(
    "uses PF_ORG when no org path argument is provided",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GOOGLE_CLIENT_ID: "google-client-id",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
        GRAPHQL_SERVER_URL: "http://127.0.0.1:1",
        OAUTH_ISSUER_URL: "http://issuer.test",
        PF_IMPORT_MODE: "deploy-artifact",
        PF_ORG: artifactRoot,
      }
      delete env["SQLITE_DATABASE_PATH"]

      const result = spawnSync("bun", [PFCLI, "import"], {
        cwd: WORKSPACE_ROOT,
        env,
        encoding: "utf8",
        timeout: IMPORT_TEST_TIMEOUT_MS,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain("Database import completed")
      expect(result.stdout).toContain(join(artifactRoot, "db", "pf.db"))
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it.each([
    {
      port: undefined,
      issuer: undefined,
      rpID: "localhost",
      origin: "http://localhost:3000",
    },
    {
      port: "3123",
      issuer: undefined,
      rpID: "localhost",
      origin: "http://localhost:3123",
    },
    {
      port: "3123",
      issuer: "https://auth.example.com",
      rpID: "auth.example.com",
      origin: "https://auth.example.com",
    },
  ])(
    "imports passkey configuration for $origin through the normal CLI",
    async ({ port, issuer, rpID, origin }) => {
      // Import in-place from examples/demo. Temp copies that symlink pfcli's
      // node_modules hide missing organisation runtime dependencies.
      const databaseRoot = mkdtempSync(
        join(tmpdir(), "pfcli-import-demo-workspace-"),
      )
      tempPaths.push(databaseRoot)

      const result = spawnSync("bun", [PFCLI, "import", DEMO_ORG], {
        cwd: WORKSPACE_ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          SQLITE_DATABASE_PATH: join(databaseRoot, "pf.db"),
          GRAPHQL_SERVER_URL: "http://127.0.0.1:1",
          OAUTH_ISSUER_URL: issuer,
          PF_LOCAL_FRONTEND_ORIGIN: undefined,
          PF_IMPORT_MODE: undefined,
          FRONTEND_PORT: port,
          PF_RUNTIME_ROOT: databaseRoot,
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          MY_EMAIL: "test@example.com",
          RESEND_REROUTE_EMAIL: "passkey@example.com",
        },
      })

      expect({
        status: result.status,
        error: result.status === 0 ? "" : `${result.stderr}\n${result.stdout}`,
      }).toEqual({ status: 0, error: "" })
      expect(result.stdout).toContain("Database import completed")
      const database = await connect(join(databaseRoot, "pf.db"), {
        readonly: true,
        experimental: ["multiprocess_wal"],
      })
      try {
        const statement = await database.prepare(
          "select json_extract(provider_config, '$.rpID') as rpID, json_extract(provider_config, '$.origin') as origin from pf_oauth_provider where provider_name = 'passkey'",
        )
        expect(await statement.all()).toEqual([{ rpID, origin }])
      } finally {
        await database.close()
      }
    },
    { timeout: 120_000 },
  )

  it(
    "imports successfully from an artifact root that only contains dist/org.js",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()
      const databasePath = join(artifactRoot, "db", "pf.db")
      const staleNxWorkspace = createStaleNxWorkspace()

      let notifiedProcessPaths: readonly string[] | undefined

      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as {
          processPaths?: readonly string[]
        }
        notifiedProcessPaths = body.processPaths

        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      const runImport = await loadRunImport()

      const originalCwd = process.cwd()

      await withEnv(
        {
          SQLITE_DATABASE_PATH: databasePath,
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          GRAPHQL_SERVER_URL: "http://graphql.test",
          NX_WORKSPACE_ROOT: staleNxWorkspace,
          PF_IMPORT_MODE: "deploy-artifact",
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)

            await Effect.runPromise(
              Effect.provide(runImport(artifactRoot), NodeServices.layer),
            )
          } finally {
            process.chdir(originalCwd)
          }
        },
      )

      expect(notifiedProcessPaths).toBeDefined()
      expect(notifiedProcessPaths?.length).toBeGreaterThan(0)
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "completes an artifact import when development notification servers do not respond",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()
      const databasePath = join(artifactRoot, "db", "pf.db")
      const notifications: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          notifications.push(new URL(request.url).pathname)
          return new Promise<Response>(() => {})
        },
      })
      writeFileSync(
        join(artifactRoot, ".frontend-port.json"),
        JSON.stringify({ port: server.port }),
      )
      const runImport = await loadRunImport()
      try {
        await withEnv(
          {
            SQLITE_DATABASE_PATH: databasePath,
            GOOGLE_CLIENT_ID: "google-client-id",
            GOOGLE_CLIENT_SECRET: "google-client-secret",
            OAUTH_ISSUER_URL: "http://issuer.test",
            GRAPHQL_SERVER_URL: server.url.toString().replace(/\/$/, ""),
            FRONTEND_BASE_URL: server.url.toString().replace(/\/$/, ""),
            PF_RUNTIME_ROOT: artifactRoot,
            PF_IMPORT_MODE: "deploy-artifact",
          },
          () =>
            Effect.runPromise(
              runImport(artifactRoot).pipe(
                Effect.provide(NodeServices.layer),
                Effect.timeout("10 seconds"),
              ),
            ),
        )
        expect(notifications.sort()).toEqual([
          "/api/dev/import-completed",
          "/internal/import-completed",
        ])
        expect(
          await readStoredFrontendJwtFromDatabasePath(databasePath),
        ).toBeDefined()
      } finally {
        server.stop(true)
      }
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "imports a process-free artifact and reports no process paths",
    async () => {
      const artifactRoot = await createProcessFreeArtifact()
      const databasePath = join(artifactRoot, "db", "pf.db")
      let notifiedProcessPaths: readonly string[] | undefined

      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as {
          processPaths?: readonly string[]
        }
        notifiedProcessPaths = body.processPaths
        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      const runImport = await loadRunImport()
      await withEnv(
        {
          SQLITE_DATABASE_PATH: databasePath,
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          GRAPHQL_SERVER_URL: "http://graphql.test",
          PF_IMPORT_MODE: "deploy-artifact",
        },
        async () => {
          await Effect.runPromise(
            Effect.provide(runImport(artifactRoot), NodeServices.layer),
          )
        },
      )

      expect(notifiedProcessPaths).toEqual([])
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "refreshes the stored frontend JWT when the issuer changes",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()
      const databaseRoot = mkdtempSync(join(tmpdir(), "pfcli-import-db-"))
      const databasePath = join(databaseRoot, "pf.db")
      tempPaths.push(databaseRoot)
      await copySharedImportedDemoDatabase(databasePath)

      globalThis.fetch = (async () =>
        new Response("", { status: 200 })) as unknown as typeof fetch

      const runImport = await loadRunImport()
      const originalCwd = process.cwd()

      const runImportWithIssuer = async (issuerUrl: string) => {
        await withEnv(
          {
            SQLITE_DATABASE_PATH: databasePath,
            GOOGLE_CLIENT_ID: "google-client-id",
            GOOGLE_CLIENT_SECRET: "google-client-secret",
            OAUTH_ISSUER_URL: issuerUrl,
            GRAPHQL_SERVER_URL: "http://graphql.test",
            PF_IMPORT_MODE: "deploy-artifact",
          },
          async () => {
            try {
              process.chdir(WORKSPACE_ROOT)

              await Effect.runPromise(
                Effect.provide(runImport(artifactRoot), NodeServices.layer),
              )
            } finally {
              process.chdir(originalCwd)
            }
          },
        )
      }

      const firstToken =
        await readStoredFrontendJwtFromDatabasePath(databasePath)
      expect(firstToken).toBeDefined()

      await runImportWithIssuer("http://issuer-two.test")
      const secondToken =
        await readStoredFrontendJwtFromDatabasePath(databasePath)
      expect(secondToken).toBeDefined()

      expect(firstToken).not.toBe(secondToken)
      expect(decodeJwtClaims(secondToken!).iss).toBe("http://issuer-two.test")
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "imports successfully from an org path without SQLITE_DATABASE_PATH",
    async () => {
      const orgRoot = await createTempOrgFromSharedBuild({
        includeCustomMigrations: true,
      })

      let notifiedProcessPaths: readonly string[] | undefined

      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as {
          processPaths?: readonly string[]
        }
        notifiedProcessPaths = body.processPaths

        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      const runImport = await loadRunImport()
      const originalCwd = process.cwd()

      await withEnv(
        {
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          GRAPHQL_SERVER_URL: "http://graphql.test",
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)

            await Effect.runPromise(
              Effect.provide(runImport(orgRoot), NodeServices.layer),
            )
          } finally {
            process.chdir(originalCwd)
          }
        },
      )

      expect(notifiedProcessPaths).toBeDefined()
      expect(notifiedProcessPaths?.length).toBeGreaterThan(0)
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "loads the Turso Cloud layer for remote imports from an artifact root",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()
      const staleNxWorkspace = createStaleNxWorkspace()

      const originalCwd = process.cwd()

      await withEnv(
        {
          SQLITE_DATABASE_PATH: "libsql://example.invalid",
          TURSO_AUTH_TOKEN: "dummy-token",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          NX_WORKSPACE_ROOT: staleNxWorkspace,
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)

            const bundle = (await import(
              join(artifactRoot, "dist", "org.js")
            )) as {
              dbImport?: Effect.Effect<unknown>
            }

            expect(Effect.isEffect(bundle.dbImport)).toBe(true)

            let errorMessage = ""

            try {
              await Effect.runPromise(bundle.dbImport as Effect.Effect<unknown>)
            } catch (error) {
              errorMessage =
                error instanceof Error ? error.message : String(error)
            }

            expect(errorMessage).not.toContain("Cannot find module")
            expect(errorMessage).not.toContain("Not a valid effect")
            expect(errorMessage.length).toBeGreaterThan(0)
          } finally {
            process.chdir(originalCwd)
          }
        },
      )
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "fails closed when the deploy artifact manifest is missing",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()

      const runImport = await loadRunImport()
      const originalCwd = process.cwd()
      let exit: Exit.Exit<unknown, unknown> | undefined

      await withEnv(
        {
          SQLITE_DATABASE_PATH: join(artifactRoot, "db", "pf.db"),
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          PF_IMPORT_MODE: "deploy-artifact",
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)
            rmSync(join(artifactRoot, "dist", "deploy-manifest.json"))

            exit = await Effect.runPromiseExit(
              Effect.provide(runImport(artifactRoot), NodeServices.layer),
            )
          } finally {
            process.chdir(originalCwd)
          }
        },
      )

      expect(exit).toBeDefined()
      expect(Exit.isFailure(exit!)).toBe(true)
      expect(getFailureCauseMessage(exit!)).toContain(
        "Organisation deploy manifest not found",
      )
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "fails closed when the deploy artifact bundle hash no longer matches the manifest",
    async () => {
      const artifactRoot = await createTempOrgFromSharedBuild()

      const runImport = await loadRunImport()
      const originalCwd = process.cwd()
      let exit: Exit.Exit<unknown, unknown> | undefined

      await withEnv(
        {
          SQLITE_DATABASE_PATH: join(artifactRoot, "db", "pf.db"),
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          PF_IMPORT_MODE: "deploy-artifact",
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)
            writeFileSync(
              join(artifactRoot, "dist", "org.js"),
              readFileSync(join(artifactRoot, "dist", "org.js"), "utf8") +
                "export const tampered = true\n",
            )

            exit = await Effect.runPromiseExit(
              Effect.provide(runImport(artifactRoot), NodeServices.layer),
            )
          } finally {
            process.chdir(originalCwd)
          }
        },
      )

      expect(exit).toBeDefined()
      expect(Exit.isFailure(exit!)).toBe(true)
      expect(getFailureCauseMessage(exit!)).toContain(
        "Organisation bundle hash mismatch",
      )
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )

  it(
    "does not rebuild from source when deploy import requires a built artifact",
    async () => {
      const artifactRoot = mkdtempSync(join(tmpdir(), "pfcli-import-artifact-"))
      tempPaths.push(artifactRoot)

      mkdirSync(join(artifactRoot, "src"), { recursive: true })
      writeFileSync(
        join(artifactRoot, "src", "index.ts"),
        "export const org = {}\n",
      )

      const runImport = await loadRunImport()
      const originalCwd = process.cwd()
      let exit: Exit.Exit<unknown, unknown> | undefined

      await withEnv(
        {
          SQLITE_DATABASE_PATH: join(artifactRoot, "db", "pf.db"),
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          OAUTH_ISSUER_URL: "http://issuer.test",
          PF_IMPORT_MODE: "deploy-artifact",
        },
        async () => {
          try {
            process.chdir(WORKSPACE_ROOT)

            exit = await Effect.runPromiseExit(
              Effect.provide(runImport(artifactRoot), NodeServices.layer),
            )
          } finally {
            process.chdir(originalCwd)
          }
        },
      )

      expect(exit).toBeDefined()
      expect(Exit.isFailure(exit!)).toBe(true)
      expect(getFailureCauseMessage(exit!)).toContain(
        "Deploy artifact bundle not found",
      )
    },
    { timeout: IMPORT_TEST_TIMEOUT_MS },
  )
})
