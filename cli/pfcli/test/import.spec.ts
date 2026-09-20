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
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Option } from "effect"
import {
  DEMO_ORG,
  captureStdout,
  copySharedBuiltDemoArtifact,
  copySharedImportedDemoDatabase,
  loadPfcliCommand,
  readStoredFrontendJwtFromDatabasePath,
  runPfcliInProcess,
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
type RunImportWatch = (
  orgPath: string,
  options: {
    readonly debounceMs?: number
    readonly skipInitialImport?: boolean
    readonly signal?: AbortSignal
    readonly runImportOnce?: (
      orgPath: string,
      signal?: AbortSignal,
      options?: ImportCycleOptions,
    ) => Promise<void>
    readonly createWatchers?: (
      orgPath: string,
      onChange: (event: {
        readonly eventType: string
        readonly path: string
      }) => void,
    ) => readonly { readonly close: () => void }[]
  },
) => Effect.Effect<unknown>

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

const loadRunImport = async (): Promise<RunImport> => {
  const module = await loadPfcliCommand<{
    runImport: RunImport
  }>("import")
  return module.runImport
}

const loadRunImportWatch = async (): Promise<RunImportWatch> => {
  const module = await loadPfcliCommand<{
    runImportWatch: RunImportWatch
  }>("import")
  return module.runImportWatch
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
  await Effect.runPromise(Effect.provide(runBuild(orgRoot), NodeContext.layer))

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
    const errorOption = Cause.failureOption(exit.cause)

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
  it("watch mode debounces changes, reports timing, and recovers after failure", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const initialDone = deferred()
    const failedCycleDone = deferred()
    const recoveredCycleDone = deferred()
    let calls = 0
    let closed = false
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const { output } = await captureStdout(async () => {
      const watchPromise = Effect.runPromise(
        runImportWatch("/tmp/watch-org", {
          debounceMs: 5,
          signal: controller.signal,
          createWatchers: (_orgPath, onChange) => {
            emitChange = onChange
            return [
              {
                close: () => {
                  closed = true
                },
              },
            ]
          },
          runImportOnce: async () => {
            calls += 1

            if (calls === 1) {
              initialDone.resolve()
              return
            }

            if (calls === 2) {
              failedCycleDone.resolve()
              throw new Error("temporary broken save")
            }

            recoveredCycleDone.resolve()
            controller.abort()
          },
        }),
      )

      await initialDone.promise
      emitChange?.({
        eventType: "rename",
        path: "/tmp/watch-org/src/.#enrolment-enquiry.ts",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/#enrolment-enquiry.ts#",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/enrolment-enquiry.ts~",
      })
      emitChange?.({
        eventType: "change",
        path: "/tmp/watch-org/src/.enrolment-enquiry.ts.swp",
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toBe(1)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/b.ts" })
      await failedCycleDone.promise
      expect(calls).toBe(2)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      await recoveredCycleDone.promise
      await watchPromise
    })

    expect(calls).toBe(3)
    expect(closed).toBe(true)
    expect(output).toContain("[import:watch] watching /tmp/watch-org")
    expect(output).not.toContain("ignored editor temp file")
    expect(output).not.toContain(".#enrolment-enquiry.ts")
    expect(output).not.toContain("#enrolment-enquiry.ts#")
    expect(output).not.toContain(".enrolment-enquiry.ts.swp")
    expect(output).toContain("change detected: /tmp/watch-org/src/a.ts")
    expect(output).toContain("cycle 1 completed in")
    expect(output).toContain("cycle 2 failed in")
    expect(output).toContain("temporary broken save")
    expect(output).toContain("cycle 3 completed in")
  })

  it("watch mode uses fast cycles except for migration-related changes", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const initialDone = deferred()
    const sourceChangeDone = deferred()
    const drizzleChangeDone = deferred()
    const cycleOptions: ImportCycleOptions[] = []
    let calls = 0
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const watchPromise = Effect.runPromise(
      runImportWatch("/tmp/watch-org", {
        debounceMs: 5,
        signal: controller.signal,
        createWatchers: (_orgPath, onChange) => {
          emitChange = onChange
          return [{ close: () => undefined }]
        },
        runImportOnce: async (_orgPath, _signal, options) => {
          calls += 1
          if (options) {
            cycleOptions.push(options)
          }

          if (calls === 1) {
            initialDone.resolve()
            return
          }

          if (calls === 2) {
            sourceChangeDone.resolve()
            return
          }

          drizzleChangeDone.resolve()
          controller.abort()
        },
      }),
    )

    await initialDone.promise
    emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
    await sourceChangeDone.promise

    emitChange?.({
      eventType: "change",
      path: "/tmp/watch-org/drizzle/0001_custom.sql",
    })
    await drizzleChangeDone.promise
    await watchPromise

    expect(cycleOptions).toEqual([
      { runMigrations: true, ensureFrontendJwt: true },
      { runMigrations: false, ensureFrontendJwt: false },
      { runMigrations: true, ensureFrontendJwt: true },
    ])
  })

  it("watch mode can skip the initial import after startup bootstrap", async () => {
    const runImportWatch = await loadRunImportWatch()
    const controller = new AbortController()
    const watchedCycleDone = deferred()
    const cycleOptions: ImportCycleOptions[] = []
    let calls = 0
    let emitChange:
      | ((event: { readonly eventType: string; readonly path: string }) => void)
      | undefined

    const { output } = await captureStdout(async () => {
      const watchPromise = Effect.runPromise(
        runImportWatch("/tmp/watch-org", {
          debounceMs: 5,
          skipInitialImport: true,
          signal: controller.signal,
          createWatchers: (_orgPath, onChange) => {
            emitChange = onChange
            return [{ close: () => undefined }]
          },
          runImportOnce: async (_orgPath, _signal, options) => {
            calls += 1
            if (options) {
              cycleOptions.push(options)
            }
            watchedCycleDone.resolve()
            controller.abort()
          },
        }),
      )

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toBe(0)

      emitChange?.({ eventType: "change", path: "/tmp/watch-org/src/a.ts" })
      await watchedCycleDone.promise
      await watchPromise
    })

    expect(calls).toBe(1)
    expect(cycleOptions).toEqual([
      { runMigrations: false, ensureFrontendJwt: false },
    ])
    expect(output).toContain(
      "[import:watch] initial import skipped; using completed bootstrap",
    )
    expect(output).toContain("cycle 1 completed in")
  })

  it("warns when watch-skip-initial is used without watch mode", async () => {
    const orgRoot = mkdtempSync(join(tmpdir(), "pfcli-import-no-watch-"))
    tempPaths.push(orgRoot)

    const result = await runPfcliInProcess([
      "import",
      orgRoot,
      "--watch-skip-initial",
    ])

    expect(result.output).toContain(
      "--watch-skip-initial is ignored unless --watch is also set",
    )
  })

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

  it(
    "imports the demo organisation from its workspace path",
    () => {
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
          OAUTH_ISSUER_URL: "http://issuer.test",
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
              Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
            Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
                Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
              Effect.provide(runImport(orgRoot), NodeContext.layer),
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
              Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
              Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
              Effect.provide(runImport(artifactRoot), NodeContext.layer),
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
