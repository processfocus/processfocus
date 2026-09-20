import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  type FSWatcher,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"
import { FileSystem } from "@effect/platform"
import type { SqlError } from "@effect/sql/SqlError"
import { Console, Data, Effect, Schema } from "effect"
import {
  createClientJwt,
  readFrontendJwt,
  storeFrontendJwt,
} from "@pf/auth-api"
import { getAudience, getClientId } from "@pf/auth-session"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  isLocalFilePath,
  resolveDatabasePath,
} from "@pf/db-info"
import {
  getEffectiveFrontendBaseUrl,
  readGraphqlPort,
} from "@pf/frontend-endpoints/port-files"
import {
  ORGANISATION_DEPLOY_MANIFEST_FILE,
  parseOrganisationDeployManifest,
} from "@pf/process"
import { type MigrationError, OrgLoadError } from "../errors"
import type { BundledDbImportResult } from "../utils/bundled-db-import"
import { makeFrontendJwtStorageLayer } from "../utils/frontend-jwt-storage-layer"
import { resolveIssuerUrl } from "../utils/resolve-issuer-url"
import { runBuild } from "./build"
import { runMigrate } from "./migrate"

class NotifyError extends Data.TaggedError("NotifyError")<{
  readonly cause: unknown
}> {}

const JsonValue = Schema.parseJson(Schema.Unknown)

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

const frontendJwtMatchesExpectedClaims = (
  token: string,
  expectedIssuerUrl: string,
  expectedAudience: string,
): boolean => {
  try {
    const [, payload] = token.split(".")
    if (!payload) return false

    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      iss?: unknown
      aud?: unknown
    }

    const issuerMatches =
      typeof claims.iss === "string" &&
      stripTrailingSlash(claims.iss) === stripTrailingSlash(expectedIssuerUrl)

    const audienceMatches =
      claims.aud === expectedAudience ||
      (Array.isArray(claims.aud) && claims.aud.includes(expectedAudience))

    return issuerMatches && audienceMatches
  } catch {
    return false
  }
}

/**
 * Notifies the GraphQL server that an import completed, so it can
 * push updates to connected frontends via WebSocket subscriptions.
 * Fire-and-forget: failures are logged as warnings but don't fail the import.
 */
const notifyImportCompleted = (processPaths: readonly string[]) =>
  Effect.gen(function* () {
    const serverUrl =
      process.env["GRAPHQL_SERVER_URL"] ??
      `http://localhost:${readGraphqlPort()}`
    const secret = process.env["INTERNAL_API_SECRET"]

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (secret) {
      headers["x-callback-secret"] = secret
    }

    const requestBody = yield* Schema.encode(JsonValue)({ processPaths }).pipe(
      Effect.mapError((cause) => new NotifyError({ cause })),
    )

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${serverUrl}/internal/import-completed`, {
          method: "POST",
          headers,
          body: requestBody,
        }),
      catch: (cause) => new NotifyError({ cause }),
    })

    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new NotifyError({ cause }),
      })
      return yield* new NotifyError({
        cause: `Server returned ${response.status}: ${text}`,
      })
    }

    yield* Console.log("Frontend notified of changes")
  }).pipe(
    Effect.catchAll((error) =>
      Console.warn(
        `⚠️  Could not notify frontend: ${formatUnknownError(error)}`,
      ),
    ),
  )

const notifyFrontendDevImportCompleted = (processPaths: readonly string[]) =>
  Effect.gen(function* () {
    const requestBody = yield* Schema.encode(JsonValue)({ processPaths }).pipe(
      Effect.mapError((cause) => new NotifyError({ cause })),
    )
    const frontendBaseUrl = getEffectiveFrontendBaseUrl()

    yield* Effect.tryPromise({
      try: () =>
        fetch(`${frontendBaseUrl}/api/dev/import-completed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        }),
      catch: (cause) => new NotifyError({ cause }),
    })
  }).pipe(
    Effect.catchAll((error) =>
      Console.warn(
        `⚠️  Could not notify frontend dev event stream: ${formatUnknownError(error)}`,
      ),
    ),
  )

interface BuiltOrgImportModule {
  readonly dbImport?: Effect.Effect<BundledDbImportResult, unknown>
}

const DEPLOY_ARTIFACT_IMPORT_MODE = "deploy-artifact"
const DEFAULT_IMPORT_WATCH_DEBOUNCE_MS = 300

interface ImportWatchHandle {
  readonly close: () => void
}

interface ImportWatchEvent {
  readonly eventType: string
  readonly path: string
}

interface ImportWatchPromiseOptions {
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
    onChange: (event: ImportWatchEvent) => void,
  ) => readonly ImportWatchHandle[]
}

interface ImportCycleOptions {
  readonly runMigrations: boolean
  readonly ensureFrontendJwt: boolean
}

type RunImportOptions = Partial<ImportCycleOptions>

const isDeployArtifactImport = (): boolean =>
  process.env["PF_IMPORT_MODE"] === DEPLOY_ARTIFACT_IMPORT_MODE

const formatUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const formatUnexpectedDefect = (defect: unknown): string =>
  defect instanceof Error
    ? (defect.stack ?? defect.message)
    : inspect(defect, { breakLength: 120, depth: 4 })

const runImportInChildProcess = (
  orgPath: string,
  signal?: AbortSignal,
  options: ImportCycleOptions = {
    runMigrations: true,
    ensureFrontendJwt: true,
  },
): Promise<void> => {
  const sourceCliPath = fileURLToPath(new URL("../main.ts", import.meta.url))
  const cliPath = existsSync(sourceCliPath)
    ? sourceCliPath
    : fileURLToPath(new URL("./main.mjs", import.meta.url))
  const env = {
    ...process.env,
    ...(options.runMigrations ? {} : { PF_IMPORT_SKIP_MIGRATIONS: "1" }),
    ...(options.ensureFrontendJwt ? {} : { PF_IMPORT_SKIP_FRONTEND_JWT: "1" }),
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", cliPath, "import", orgPath], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    })
    const abortChild = () => child.kill("SIGTERM")

    if (signal?.aborted) {
      abortChild()
    } else {
      signal?.addEventListener("abort", abortChild, { once: true })
    }

    child.on("error", (error) => {
      signal?.removeEventListener("abort", abortChild)
      reject(error)
    })
    child.on("exit", (code, exitSignal) => {
      signal?.removeEventListener("abort", abortChild)
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          exitSignal
            ? `pfcli import exited with signal ${exitSignal}`
            : `pfcli import exited with code ${code ?? "unknown"}`,
        ),
      )
    })
  })
}

const readImportWatchDebounceMs = (): number => {
  const raw = process.env["PF_IMPORT_WATCH_DEBOUNCE_MS"]
  if (!raw) return DEFAULT_IMPORT_WATCH_DEBOUNCE_MS

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_IMPORT_WATCH_DEBOUNCE_MS
}

const formatDurationMs = (durationMs: number): string =>
  `${Math.round(durationMs)}ms`

const isIgnoredImportWatchPath = (path: string): boolean => {
  const fileName = basename(path)
  return (
    fileName.startsWith(".#") ||
    (fileName.startsWith("#") && fileName.endsWith("#")) ||
    fileName.endsWith("~") ||
    fileName.endsWith(".swp") ||
    fileName.endsWith(".swo") ||
    fileName.endsWith(".swx")
  )
}

const importWatchPathRequiresFullImport = (path: string): boolean => {
  const normalizedPath = path.replaceAll("\\", "/")
  return (
    normalizedPath.endsWith("/drizzle.config.ts") ||
    normalizedPath.includes("/drizzle/")
  )
}

const collectExistingWatchPaths = (orgPath: string): readonly string[] => {
  const absoluteOrgPath = resolve(process.cwd(), orgPath)
  const roots = [
    join(absoluteOrgPath, "src"),
    join(absoluteOrgPath, "cedar"),
    join(absoluteOrgPath, "drizzle"),
    join(absoluteOrgPath, "drizzle.config.ts"),
  ]
  const paths = new Set<string>()

  const addPath = (path: string) => {
    if (!existsSync(path)) return

    paths.add(path)
    const stat = statSync(path)
    if (!stat.isDirectory()) return

    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      if (entry.isDirectory()) {
        addPath(join(path, entry.name))
      }
    }
  }

  for (const root of roots) {
    addPath(root)
  }

  return [...paths]
}

const createFilesystemImportWatchers = (
  orgPath: string,
  onChange: (event: ImportWatchEvent) => void,
): readonly ImportWatchHandle[] => {
  const watchPaths = collectExistingWatchPaths(orgPath)
  const watchers: FSWatcher[] = []

  for (const watchPath of watchPaths) {
    const watcher = watch(watchPath, (eventType, filename) => {
      onChange({
        eventType,
        path: filename ? join(watchPath, filename.toString()) : watchPath,
      })
    })
    watchers.push(watcher)
  }

  return watchers.map((watcher) => ({
    close: () => watcher.close(),
  }))
}

const runImportWatchPromise = async (
  orgPath: string,
  options: ImportWatchPromiseOptions = {},
): Promise<void> => {
  const debounceMs = options.debounceMs ?? readImportWatchDebounceMs()
  const skipInitialImport = options.skipInitialImport ?? false
  const signal = options.signal
  const runImportOnce =
    options.runImportOnce ??
    ((
      path: string,
      cycleSignal?: AbortSignal,
      cycleOptions?: ImportCycleOptions,
    ) => runImportInChildProcess(path, cycleSignal, cycleOptions))
  const createWatchers =
    options.createWatchers ?? createFilesystemImportWatchers

  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let queued = false
  let queuedRequiresFullImport = false
  let scheduledRequiresFullImport = false
  let cycle = 0
  let watchers: readonly ImportWatchHandle[] = []

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  const closeWatchers = () => {
    clearTimer()
    for (const watcher of watchers) {
      watcher.close()
    }
    watchers = []
  }

  const runCycle = async (
    reason: string,
    requiresFullImport: boolean,
  ): Promise<void> => {
    if (signal?.aborted) return

    if (running) {
      queued = true
      queuedRequiresFullImport ||= requiresFullImport
      return
    }

    running = true
    queued = false
    queuedRequiresFullImport = false
    cycle += 1
    const cycleNumber = cycle
    const startedAt = performance.now()
    const cycleOptions: ImportCycleOptions = {
      runMigrations: requiresFullImport,
      ensureFrontendJwt: requiresFullImport,
    }

    console.log(
      `\n[import:watch] cycle ${cycleNumber} started (${reason}${requiresFullImport ? ", full" : ", fast"})`,
    )

    try {
      await runImportOnce(orgPath, signal, cycleOptions)
      console.log(
        `[import:watch] cycle ${cycleNumber} completed in ${formatDurationMs(
          performance.now() - startedAt,
        )}`,
      )
    } catch (error) {
      if (signal?.aborted) return

      console.error(
        `[import:watch] cycle ${cycleNumber} failed in ${formatDurationMs(
          performance.now() - startedAt,
        )}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      running = false
    }

    if (queued && !signal?.aborted) {
      scheduleCycle("changes during previous cycle", queuedRequiresFullImport)
    }
  }

  const scheduleCycle = (reason: string, requiresFullImport: boolean) => {
    scheduledRequiresFullImport ||= requiresFullImport
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      const requiresFullImportForCycle = scheduledRequiresFullImport
      scheduledRequiresFullImport = false
      void runCycle(reason, requiresFullImportForCycle)
    }, debounceMs)
  }

  console.log(
    `[import:watch] watching ${resolve(process.cwd(), orgPath)} (debounce ${debounceMs}ms)`,
  )

  watchers = createWatchers(orgPath, (event) => {
    if (isIgnoredImportWatchPath(event.path)) {
      return
    }

    console.log(`[import:watch] change detected: ${event.path}`)
    scheduleCycle(
      `${event.eventType} ${event.path}`,
      importWatchPathRequiresFullImport(event.path),
    )
  })

  if (watchers.length === 0) {
    console.warn(
      skipInitialImport
        ? "[import:watch] no existing source paths to watch; skip-initial mode assumes a separate bootstrap import has already completed. Later saves will not be observed until watch mode is restarted"
        : "[import:watch] no existing source paths to watch yet; initial import will still run",
    )
  }

  signal?.addEventListener("abort", closeWatchers, { once: true })

  if (skipInitialImport) {
    console.log(
      "[import:watch] initial import skipped; using completed bootstrap",
    )
  } else {
    await runCycle("initial", true)
  }

  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    signal?.addEventListener("abort", () => resolve(), { once: true })
  })
}

/**
 * Type guard for objects with string index signature
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * Extracts Drizzle query information from an error cause.
 * Returns an object with optional query and params properties.
 */
const extractDrizzleInfo = (
  cause: unknown,
): { query?: string; params?: unknown[] } => {
  if (!isRecord(cause)) {
    return {}
  }

  const result: { query?: string; params?: unknown[] } = {}

  if (typeof cause["query"] === "string") {
    result.query = cause["query"]
  }

  if (Array.isArray(cause["params"])) {
    result.params = cause["params"]
  }

  return result
}

/**
 * Extracts the root error message from a cause chain.
 * Traverses nested cause objects until finding a message property.
 */
const extractRootMessage = (cause: unknown): string | undefined => {
  let current: unknown = cause

  while (isRecord(current)) {
    // If we found a message, check if there's a deeper cause
    if ("cause" in current) {
      current = current["cause"]
      continue
    }

    // No more nested causes, return the message if present
    if (typeof current["message"] === "string") {
      return current["message"]
    }

    break
  }

  return undefined
}

/**
 * Ensure the parent directory for a database path exists.
 * Only creates directories for local file paths.
 */
const ensureDatabaseDirectory = (databasePath: string) =>
  Effect.gen(function* () {
    if (!isLocalFilePath(databasePath)) return

    const fs = yield* FileSystem.FileSystem
    const dir = dirname(databasePath)

    const exists = yield* fs.exists(dir)
    if (!exists) {
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* Console.log(`Created database directory: ${dir}`)
    }
  })

const withDatabasePathEnv = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env["SQLITE_DATABASE_PATH"]
      process.env["SQLITE_DATABASE_PATH"] = databasePath
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env["SQLITE_DATABASE_PATH"]
          return
        }

        process.env["SQLITE_DATABASE_PATH"] = previous
      }),
  )

const readOrganisationDeployManifestFromFile = (manifestPath: string) => {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Organisation deploy manifest not found: ${manifestPath}. Re-run deploy with a freshly built artifact.`,
    )
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Organisation deploy manifest at ${manifestPath} is not valid JSON. Re-run deploy with a freshly built artifact.`,
      { cause: error },
    )
  }

  try {
    return parseOrganisationDeployManifest(parsed)
  } catch (error) {
    throw new Error(
      `Organisation deploy manifest at ${manifestPath} is invalid: ${error instanceof Error ? error.message : String(error)}. Re-run deploy with a freshly built artifact.`,
      { cause: error },
    )
  }
}

const loadBuiltOrgImport = (orgPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const deployArtifactMode = isDeployArtifactImport()
    const absoluteOrgPath = resolve(process.cwd(), orgPath)
    const sourcePath = join(absoluteOrgPath, "src", "index.ts")
    const distBundlePath = join(absoluteOrgPath, "dist", "org.js")
    const directBundlePath = join(absoluteOrgPath, "org.js")
    const deployManifestPath = join(
      absoluteOrgPath,
      "dist",
      ORGANISATION_DEPLOY_MANIFEST_FILE,
    )

    if (deployArtifactMode) {
      yield* Effect.try({
        try: () => {
          if (!existsSync(distBundlePath)) {
            throw new Error(
              `Deploy artifact bundle not found: ${distBundlePath}. Re-run deploy with a freshly built artifact.`,
            )
          }

          const deployManifest =
            readOrganisationDeployManifestFromFile(deployManifestPath)
          // Defense-in-depth: re-verify hash inside the sandbox after crossing
          // the trust boundary from the outer deploy-time validation.
          const bundleSha256 = createHash("sha256")
            .update(readFileSync(distBundlePath))
            .digest("hex")

          if (bundleSha256 !== deployManifest.orgBundleSha256) {
            throw new Error(
              `Organisation bundle hash mismatch for ${distBundlePath}. Re-run deploy with a freshly built artifact.`,
            )
          }
        },
        catch: (cause) =>
          new OrgLoadError({
            path: orgPath,
            cause,
          }),
      })
    } else {
      const sourceExists = yield* fs.exists(sourcePath)
      if (sourceExists) {
        yield* runBuild(orgPath)
      }
    }

    const distBundleExists = yield* fs.exists(distBundlePath)
    const bundlePath = deployArtifactMode
      ? distBundlePath
      : distBundleExists
        ? distBundlePath
        : (yield* fs.exists(directBundlePath))
          ? directBundlePath
          : undefined

    if (!bundlePath) {
      return yield* new OrgLoadError({
        path: orgPath,
        cause: new Error(
          `Built organisation bundle not found. Checked ${distBundlePath} and ${directBundlePath}`,
        ),
      })
    }

    const module = yield* Effect.tryPromise({
      try: async () => (await import(bundlePath)) as BuiltOrgImportModule,
      catch: (error) =>
        new OrgLoadError({
          path: orgPath,
          cause: error,
        }),
    })

    if (!module.dbImport || !Effect.isEffect(module.dbImport)) {
      return yield* new OrgLoadError({
        path: orgPath,
        cause: new Error(
          `Built organisation bundle at ${bundlePath} must export a 'dbImport' Effect.`,
        ),
      })
    }

    return {
      bundlePath,
      dbImport: module.dbImport as Effect.Effect<
        BundledDbImportResult,
        unknown
      >,
    }
  })

/**
 * Import command - loads organisation and stores in database.
 *
 * @param orgPath - Path to organisation directory
 */
export const runImport = (orgPath: string, options: RunImportOptions = {}) =>
  Effect.gen(function* () {
    const runMigrations =
      options.runMigrations ?? process.env["PF_IMPORT_SKIP_MIGRATIONS"] !== "1"
    const ensureFrontendJwt =
      options.ensureFrontendJwt ??
      process.env["PF_IMPORT_SKIP_FRONTEND_JWT"] !== "1"
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      // return needed for type narrowing in Effect.gen
      return yield* new OrgLoadError({
        path: orgPath,
        cause: DATABASE_PATH_NOT_CONFIGURED,
      })
    }

    yield* ensureDatabaseDirectory(databasePath)

    const { bundlePath, dbImport } = yield* loadBuiltOrgImport(orgPath)

    yield* Console.log(`Using built organisation bundle: ${bundlePath}`)

    // Run system + org migrations before importing.
    // MigrationError is caught here for user-friendly output, then
    // re-thrown so the command exits non-zero. @effect/cli treats an
    // unhandled tagged error as a silent exit(1).
    if (runMigrations) {
      yield* runMigrate(orgPath).pipe(
        Effect.catchTag("MigrationError", (error: MigrationError) =>
          Effect.gen(function* () {
            yield* Console.error(`\n❌ Migration failed: ${error.reason}`)
            if (error.statement) {
              yield* Console.error(`   Statement: ${error.statement}`)
            }
            return yield* error
          }),
        ),
      )
    } else {
      yield* Console.log("Skipping migrations for import watch fast path")
    }

    yield* Console.log(`Importing to database: ${databasePath}`)

    const openAuthLayer = makeFrontendJwtStorageLayer(databasePath)

    // Import to database
    yield* withDatabasePathEnv(
      databasePath,
      dbImport.pipe(
        Effect.tap(({ orgName }) =>
          Console.log(`Loaded organisation: ${orgName}`),
        ),
        Effect.tap(() =>
          Console.log(`✅ Database import completed: ${databasePath}`),
        ),
        // Only create frontend JWT when one does not already exist.
        // This keeps the token stable across imports so that Nx can
        // cache next-build / build-opennext (FRONTEND_JWT_TOKEN is a
        // cache input). Use 'pfcli refresh-frontend-jwt' to regenerate.
        Effect.tap(() =>
          ensureFrontendJwt
            ? Effect.gen(function* () {
                const issuerUrl = resolveIssuerUrl()
                const clientId = getClientId()
                const audience = getAudience()
                const existing = yield* readFrontendJwt(clientId)
                if (
                  existing &&
                  frontendJwtMatchesExpectedClaims(
                    existing,
                    issuerUrl,
                    audience,
                  )
                ) {
                  yield* Console.log(
                    "Frontend JWT already exists, skipping creation (run 'pfcli refresh-frontend-jwt' to regenerate)",
                  )
                  return
                }

                if (existing) {
                  yield* Console.log(
                    "Frontend JWT issuer or audience changed, refreshing token",
                  )
                }

                const token = yield* createClientJwt({
                  clientId,
                  issuerUrl,
                  audience,
                })
                yield* storeFrontendJwt(clientId, token)
                yield* Console.log("Frontend JWT stored in database")
              }).pipe(
                Effect.provide(openAuthLayer),
                Effect.catchAll((error) =>
                  Console.warn(
                    `⚠️  Could not create frontend JWT: ${formatUnknownError(error)}`,
                  ),
                ),
              )
            : Console.log(
                "Skipping frontend JWT check for import watch fast path",
              ),
        ),
        Effect.tap(({ processPaths }) =>
          Effect.all(
            [
              notifyImportCompleted(processPaths),
              notifyFrontendDevImportCompleted(processPaths),
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.catchTags({
          SqlError: (error: SqlError) =>
            Effect.gen(function* () {
              yield* Console.error("\n❌ SQL Error:")

              const { cause } = error

              // Extract query and params if available (Drizzle error structure)
              const drizzleInfo = extractDrizzleInfo(cause)
              if (drizzleInfo.query) {
                yield* Console.error(`   Query: ${drizzleInfo.query}`)
              }
              if (drizzleInfo.params) {
                yield* Console.error(
                  `   Params: ${globalThis.JSON.stringify(drizzleInfo.params)}`,
                )
              }

              // Extract the deepest error message from the cause chain
              const rootMessage = extractRootMessage(cause) ?? error.message
              if (rootMessage) {
                yield* Console.error(`   Error: ${rootMessage}`)
              }

              return yield* error
            }),
        }),
        Effect.tapDefect((defect) =>
          Effect.gen(function* () {
            yield* Console.error("\n❌ Unexpected error occurred:")
            yield* Console.error(formatUnexpectedDefect(defect))
          }),
        ),
      ),
    )
  })

export const runImportWatch = (
  orgPath: string,
  options: ImportWatchPromiseOptions = {},
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController()
      const abort = () => controller.abort()

      if (options.signal?.aborted) {
        abort()
      } else {
        options.signal?.addEventListener("abort", abort, { once: true })
      }

      return { abort, controller }
    }),
    ({ controller }) =>
      Effect.tryPromise({
        try: () =>
          runImportWatchPromise(orgPath, {
            ...options,
            signal: controller.signal,
          }),
        catch: (cause) =>
          new OrgLoadError({
            path: orgPath,
            cause,
          }),
      }),
    ({ abort, controller }) =>
      Effect.sync(() => {
        options.signal?.removeEventListener("abort", abort)
        controller.abort()
      }),
  )
