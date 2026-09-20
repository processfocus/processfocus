import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Option } from "effect"
import { FRONTEND_CLIENT_ID, readFrontendJwt } from "@pf/auth-api"
import { resolveDatabasePath } from "@pf/db-info"
import { makeFrontendJwtStorageLayer } from "../src/utils/frontend-jwt-storage-layer"
import { Database } from "bun:sqlite"
import { afterEach, beforeEach } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
export const DEMO_ORG = resolve(WORKSPACE_ROOT, "examples/demo")

type RunBuild = (orgPath: string, outputDir?: string) => Effect.Effect<unknown>

const SHARED_DEMO_BUILD_ID =
  process.env["PFCLI_TEST_RUN_ID"] ?? String(process.pid)
const SHARED_DEMO_BUILD_ROOT = join(
  tmpdir(),
  `pfcli-shared-demo-build-${SHARED_DEMO_BUILD_ID}`,
)
const SHARED_DEMO_BUILD_LOCK_DIR = `${SHARED_DEMO_BUILD_ROOT}.lock`
const SHARED_DEMO_BUILD_ORG_ROOT = join(SHARED_DEMO_BUILD_ROOT, "org")
const SHARED_DEMO_BUILD_DIST_DIR = join(SHARED_DEMO_BUILD_ORG_ROOT, "dist")
const SHARED_DEMO_BUILD_READY_FILE = join(SHARED_DEMO_BUILD_ROOT, ".ready")
const SHARED_IMPORTED_DEMO_ROOT = join(
  tmpdir(),
  `pfcli-shared-imported-demo-${SHARED_DEMO_BUILD_ID}`,
)
const SHARED_IMPORTED_DEMO_LOCK_DIR = `${SHARED_IMPORTED_DEMO_ROOT}.lock`
const SHARED_IMPORTED_DEMO_DATABASE_PATH = join(
  SHARED_IMPORTED_DEMO_ROOT,
  "pf.db",
)
const SHARED_IMPORTED_DEMO_READY_FILE = join(
  SHARED_IMPORTED_DEMO_ROOT,
  ".ready",
)

let sharedDemoBuildPromise: Promise<string> | undefined
let sharedImportedDemoPromise: Promise<string> | undefined

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const isSharedDemoBuildReady = () =>
  existsSync(SHARED_DEMO_BUILD_READY_FILE) &&
  existsSync(SHARED_DEMO_BUILD_DIST_DIR)

const tryAcquireSharedDemoBuildLockFor = (lockDirectory: string) => {
  try {
    mkdirSync(lockDirectory)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false
    }

    throw error
  }
}

const tryAcquireSharedDemoBuildLock = () =>
  tryAcquireSharedDemoBuildLockFor(SHARED_DEMO_BUILD_LOCK_DIR)

const loadRunBuild = async (): Promise<RunBuild> => {
  const module = await loadPfcliCommand<{
    runBuild: RunBuild
  }>("build")
  return module.runBuild
}

const getSharedBuiltDemoDistDir = async () => {
  if (sharedDemoBuildPromise) {
    return sharedDemoBuildPromise
  }

  sharedDemoBuildPromise = (async () => {
    const deadline = Date.now() + 120_000

    while (!isSharedDemoBuildReady()) {
      if (tryAcquireSharedDemoBuildLock()) {
        try {
          if (!isSharedDemoBuildReady()) {
            rmSync(SHARED_DEMO_BUILD_ROOT, { recursive: true, force: true })
            mkdirSync(SHARED_DEMO_BUILD_ROOT, { recursive: true })
            cpSync(DEMO_ORG, SHARED_DEMO_BUILD_ORG_ROOT, { recursive: true })

            const runBuild = await loadRunBuild()
            const originalCwd = process.cwd()

            try {
              process.chdir(WORKSPACE_ROOT)
              await Effect.runPromise(
                Effect.provide(
                  runBuild(SHARED_DEMO_BUILD_ORG_ROOT),
                  NodeContext.layer,
                ),
              )
            } finally {
              process.chdir(originalCwd)
            }

            writeFileSync(SHARED_DEMO_BUILD_READY_FILE, "ready\n")
          }
        } finally {
          rmSync(SHARED_DEMO_BUILD_LOCK_DIR, { recursive: true, force: true })
        }

        break
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for shared demo build to finish")
      }

      await sleep(100)
    }

    return SHARED_DEMO_BUILD_DIST_DIR
  })()

  return sharedDemoBuildPromise
}

export const copySharedBuiltDemoArtifact = async (
  targetRoot: string,
  options: { includeCustomMigrations?: boolean } = {},
) => {
  const sharedDistDir = await getSharedBuiltDemoDistDir()

  cpSync(sharedDistDir, join(targetRoot, "dist"), { recursive: true })
  // These source-level tests execute a repo-built artifact from a temporary
  // directory. Model the released dependencies an external project installs;
  // production import must never create this workspace link itself.
  symlinkSync(
    join(WORKSPACE_ROOT, "cli/pfcli/node_modules"),
    join(targetRoot, "node_modules"),
    "dir",
  )

  if (options.includeCustomMigrations) {
    cpSync(
      join(DEMO_ORG, "drizzle.config.ts"),
      join(targetRoot, "drizzle.config.ts"),
    )
    cpSync(join(DEMO_ORG, "drizzle"), join(targetRoot, "drizzle"), {
      recursive: true,
    })
  }
}

const checkpointAndCloseDatabase = (databasePath: string) => {
  const database = new Database(databasePath)

  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    database.close()
  }

  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${databasePath}${suffix}`)) {
      throw new Error(
        `Shared imported database remained live after checkpoint: ${databasePath}${suffix}`,
      )
    }
  }
}

const isSharedImportedDemoReady = () =>
  existsSync(SHARED_IMPORTED_DEMO_READY_FILE) &&
  existsSync(SHARED_IMPORTED_DEMO_DATABASE_PATH) &&
  !existsSync(`${SHARED_IMPORTED_DEMO_DATABASE_PATH}-wal`) &&
  !existsSync(`${SHARED_IMPORTED_DEMO_DATABASE_PATH}-shm`)

const getSharedImportedDemoDatabasePath = async () => {
  if (sharedImportedDemoPromise) {
    return sharedImportedDemoPromise
  }

  sharedImportedDemoPromise = (async () => {
    const deadline = Date.now() + 120_000

    while (!isSharedImportedDemoReady()) {
      if (tryAcquireSharedDemoBuildLockFor(SHARED_IMPORTED_DEMO_LOCK_DIR)) {
        try {
          if (!isSharedImportedDemoReady()) {
            rmSync(SHARED_IMPORTED_DEMO_ROOT, {
              recursive: true,
              force: true,
            })
            const orgRoot = join(SHARED_IMPORTED_DEMO_ROOT, "org")
            mkdirSync(orgRoot, { recursive: true })
            await copySharedBuiltDemoArtifact(orgRoot)

            const { runImport } = await loadPfcliCommand<{
              runImport: (orgPath: string) => Effect.Effect<unknown>
            }>("import")

            await withEnv(
              {
                SQLITE_DATABASE_PATH: SHARED_IMPORTED_DEMO_DATABASE_PATH,
                GOOGLE_CLIENT_ID: "shared-demo-client-id",
                GOOGLE_CLIENT_SECRET: "shared-demo-client-secret",
                OAUTH_ISSUER_URL: "http://localhost:4020",
                GRAPHQL_SERVER_URL: "http://127.0.0.1:1",
                // Pin invitation emails so developer-local MY_EMAIL /
                // RESEND_REROUTE_EMAIL cannot change the shared fixture.
                MY_EMAIL: "test@example.com",
                RESEND_REROUTE_EMAIL: "passkey@example.com",
              },
              () =>
                Effect.runPromise(
                  Effect.provide(runImport(orgRoot), NodeContext.layer),
                ),
            )

            checkpointAndCloseDatabase(SHARED_IMPORTED_DEMO_DATABASE_PATH)
            writeFileSync(SHARED_IMPORTED_DEMO_READY_FILE, "ready\n")
          }
        } finally {
          rmSync(SHARED_IMPORTED_DEMO_LOCK_DIR, {
            recursive: true,
            force: true,
          })
        }

        break
      }

      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for shared imported demo database to finish",
        )
      }

      await sleep(100)
    }

    return SHARED_IMPORTED_DEMO_DATABASE_PATH
  })()

  return sharedImportedDemoPromise
}

export const copySharedImportedDemoDatabase = async (
  targetDatabasePath: string,
) => {
  const baselineDatabasePath = await getSharedImportedDemoDatabasePath()
  mkdirSync(dirname(targetDatabasePath), { recursive: true })
  copyFileSync(baselineDatabasePath, targetDatabasePath)
}

export const loadPfcliCommand = async <T>(commandName: string) => {
  const module = (await import(
    join(WORKSPACE_ROOT, "cli/pfcli/src/commands", `${commandName}.ts`)
  )) as T

  return module
}

export const runPfcliInProcess = async (args: readonly string[]) => {
  const module = (await import(
    join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")
  )) as {
    runPfcliCommand: (argv: readonly string[]) => Effect.Effect<unknown>
  }
  const previousExitCode = process.exitCode
  // Bun does not clear a non-zero exit code when assigned undefined.
  process.exitCode = 0

  try {
    let commandExit: Exit.Exit<unknown, unknown> | undefined
    const { output } = await captureStdout(async () => {
      commandExit = await Effect.runPromiseExit(
        Effect.provide(
          module.runPfcliCommand(["bun", "pfcli", ...args]),
          NodeContext.layer,
        ),
      )
    })

    const processStatus = Number(process.exitCode ?? 0)
    return {
      output,
      status:
        processStatus !== 0
          ? processStatus
          : commandExit && Exit.isFailure(commandExit)
            ? 1
            : 0,
    }
  } finally {
    process.exitCode = previousExitCode ?? 0
  }
}

export const getFailureMessage = (
  exit: Exit.Exit<unknown, unknown>,
): string => {
  if (!Exit.isFailure(exit)) {
    return ""
  }

  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    return ""
  }

  const { value } = failure
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message
  }

  return value instanceof Error ? value.message : String(value)
}

export const runWithNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    // Tests use this helper when NodeContext is the only remaining runtime
    // requirement on the command effect.
    effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<A, E>,
  )

export const runWithNodeContextExit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.runPromiseExit(
    // Tests use this helper when NodeContext is the only remaining runtime
    // requirement on the command effect.
    effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<A, E>,
  )

export const readStoredFrontendJwt = async (orgPath: string) => {
  const databasePath = resolveDatabasePath(orgPath)

  if (!databasePath) {
    throw new Error(`Could not resolve database path for ${orgPath}`)
  }

  return readStoredFrontendJwtFromDatabasePath(databasePath)
}

export const readStoredFrontendJwtFromDatabasePath = (databasePath: string) =>
  Effect.runPromise(
    readFrontendJwt(FRONTEND_CLIENT_ID).pipe(
      Effect.provide(makeFrontendJwtStorageLayer(databasePath)),
    ),
  )

export const captureStdout = async <A>(run: () => Promise<A>) => {
  if (captureStdoutInUse) {
    throw new Error(
      "captureStdout cannot be used concurrently in the same process",
    )
  }

  captureStdoutInUse = true

  let output = ""
  const originalWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalLog = console.log
  const originalInfo = console.info
  const originalWarn = console.warn
  const originalError = console.error

  const append = (...values: readonly unknown[]) => {
    output += `${values.map((value) => String(value)).join(" ")}\n`
  }

  // Test helpers here assume the surrounding tests mutate process state
  // serially within a file.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  console.log = (...values: readonly unknown[]) => {
    append(...values)
  }
  console.info = (...values: readonly unknown[]) => {
    append(...values)
  }
  console.warn = (...values: readonly unknown[]) => {
    append(...values)
  }
  console.error = (...values: readonly unknown[]) => {
    append(...values)
  }

  try {
    const result = await run()
    return { output, result }
  } finally {
    captureStdoutInUse = false
    process.stdout.write = originalWrite
    process.stderr.write = originalStderrWrite
    console.log = originalLog
    console.info = originalInfo
    console.warn = originalWarn
    console.error = originalError
  }
}

let captureStdoutInUse = false

export const withEnv = async <A>(
  entries: Record<string, string | undefined>,
  run: () => Promise<A>,
) => {
  if (withEnvInUse) {
    throw new Error("withEnv cannot be used concurrently in the same process")
  }

  withEnvInUse = true

  const previousEntries = new Map<string, string | undefined>()

  // Test helpers here assume the surrounding tests mutate process state
  // serially within a file.
  for (const [key, value] of Object.entries(entries)) {
    previousEntries.set(key, process.env[key])

    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previousEntries.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    withEnvInUse = false
  }
}

let withEnvInUse = false

let sharedTestStateTail = Promise.resolve()

const acquireSharedTestState = async () => {
  let releaseLock: (() => void) | undefined
  const next = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const previous = sharedTestStateTail
  sharedTestStateTail = previous.then(() => next)
  await previous

  return () => {
    releaseLock?.()
  }
}

export const useSerializedTestState = () => {
  let releaseLock: (() => void) | undefined

  beforeEach(async () => {
    releaseLock = await acquireSharedTestState()
  })

  afterEach(() => {
    releaseLock?.()
    releaseLock = undefined
  })
}
