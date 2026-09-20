import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, unlinkSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  setDefaultTimeout,
} from "@cucumber/cucumber"
import { prepareLifecycleOrganisation } from "./lifecycle-fixture"
import { withPausedLocalWorker } from "./local-worker-pause"

// The default cucumber timeout of 5s is too tight for steps that make
// network calls through CloudFront + Lambda. Set a reasonable default.
setDefaultTimeout(10_000)

// Suppress unhandled promise rejections from WebSocket ErrorEvents.
// These occur when AWS AppSync returns HTTP 401 during WebSocket handshake,
// and the error event fires asynchronously after the test has moved on.
// The ErrorEvent is an object with no message property, so it stringifies as "[object Object]"
// or "#<ErrorEvent>". We handle the actual error in the graphql-ws error handler.
process.on("unhandledRejection", (reason) => {
  // Check if this is a WebSocket ErrorEvent (has type "error" and target)
  const isErrorEvent =
    typeof reason === "object" &&
    reason !== null &&
    "type" in reason &&
    (reason as { type: string }).type === "error"

  if (isErrorEvent) {
    // Silently ignore - the error is already captured in TestWorld.subscriptionError
    return
  }

  // Re-throw non-WebSocket errors
  throw reason
})

interface Server {
  proc: ChildProcess
  name: string
  port?: number
  restart: () => Promise<void>
}

let authServer: Server | null = null
let graphqlServer: Server | null = null
let jobWorker: Server | null = null
let workerOutput = ""
export const getLocalWorkerOutput = (): string => workerOutput
let dbPath: string | null = null
let lifecycleOrgPath: string | null = null
const lifecycleActionDirectories = new Set<string>()
export const createLifecycleControlFile = async (outcome: string) => {
  const dir = await mkdtemp(join(tmpdir(), "pf-lifecycle-action-"))
  lifecycleActionDirectories.add(dir)
  const file = join(dir, "control")
  await writeFile(file, outcome)
  return file
}

const cleanupLifecycleFiles = async () => {
  for (const dir of lifecycleActionDirectories) {
    await rm(dir, { recursive: true, force: true })
    lifecycleActionDirectories.delete(dir)
  }
  if (lifecycleOrgPath !== null) {
    await rm(lifecycleOrgPath, { recursive: true, force: true })
    lifecycleOrgPath = null
  }
}
// E2E-only file IPC: cleanup creates the pause file, and the worker writes the
// state file so cleanup can wait for active background jobs to drain.
let workerPauseFile: string | null = null
let workerStateFile: string | null = null

// Find workspace root by going up from this file's location
// This file is in apps/graphql-e2e/support/, so we go up 3 levels
const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
let DEMO_ORG_PATH = join(WORKSPACE_ROOT, "examples/demo")
/**
 * Find an available port by briefly binding to port 0
 */
const getAvailablePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("Failed to get port")))
      }
    })
    server.on("error", reject)
  })
}

/**
 * Wait for a server to respond to requests.
 * Accepts any HTTP response (including 401 Unauthorized) as a sign the server is up.
 */
const waitForServer = (url: string, timeoutMs = 30000): Promise<void> => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const check = async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ __typename }" }),
        })
        // Any response means the server is up (even 401 Unauthorized)
        if (response.status > 0) {
          resolve()
          return
        }
      } catch (err) {
        // Connection refused expected while server starts; log other errors
        if (err instanceof Error && !err.message.includes("ECONNREFUSED")) {
          console.debug(`[e2e] waitForServer unexpected error: ${err.message}`)
        }
      }
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout waiting for ${url}`))
        return
      }
      setTimeout(check, 500)
    }
    check()
  })
}

/**
 * Start a server process directly with bun on a specific port.
 * Uses --port flag to specify exact port (server fails if port is in use).
 */
const startServerOnPort = (
  name: string,
  scriptPath: string,
  port: number,
  args: string[],
  env: Record<string, string>,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log(`[e2e] Starting ${name} on port ${port}...`)

    const proc = spawn("bun", [scriptPath, "--port", String(port), ...args], {
      env: {
        ...process.env,
        ...env,
        E2E_SKIP_DELAYS: process.env["E2E_SKIP_DELAYS"] ?? "true",
      },
      cwd: WORKSPACE_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const server: Server = {
      proc,
      name,
      port,
      restart: () => startServerOnPort(name, scriptPath, port, args, env),
    }
    if (name === "auth-server") {
      authServer = server
    } else if (name === "graphql-server") {
      graphqlServer = server
    }

    let resolved = false

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      process.stdout.write(`[${name}] ${text}`)

      // Server is ready when it logs "running at"
      if (!resolved && text.includes("running at")) {
        resolved = true
        resolve()
      }
    })

    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[${name}] ${data.toString()}`)
    })

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to start ${name}: ${err.message}`))
      }
    })

    proc.on("exit", (code) => {
      if (!resolved && code !== 0) {
        resolved = true
        reject(new Error(`${name} exited with code ${code}`))
      }
    })
  })
}

/**
 * Start the job worker directly with bun and wait for it to be ready.
 * The job worker doesn't listen on a port - it just processes queue jobs.
 */
const startJobWorker = (
  scriptPath: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log("[e2e] Starting job-worker...")

    const proc = spawn("bun", [scriptPath, ...args], {
      env: {
        ...process.env,
        ...env,
        E2E_SKIP_DELAYS: process.env["E2E_SKIP_DELAYS"] ?? "true",
      },
      cwd: WORKSPACE_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    })

    jobWorker = {
      proc,
      name: "job-worker",
      restart: () => startJobWorker(scriptPath, args, env),
    }

    let resolved = false

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      workerOutput = (workerOutput + text).slice(-500_000)
      process.stdout.write(`[job-worker] ${text}`)

      // Job worker logs "Job worker started" when ready
      if (!resolved && text.includes("Job worker started")) {
        resolved = true
        resolve()
      }
    })

    proc.stderr?.on("data", (data: Buffer) => {
      workerOutput = (workerOutput + data.toString()).slice(-500_000)
      process.stderr.write(`[job-worker] ${data.toString()}`)
    })

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to start job-worker: ${err.message}`))
      }
    })

    proc.on("exit", (code) => {
      if (!resolved && code !== 0) {
        resolved = true
        reject(new Error(`job-worker exited with code ${code}`))
      }
    })
  })
}

/**
 * Run database migrations
 */
const runMigrations = (dbPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log("[e2e] Running database migrations...")

    const proc = spawn(
      "bun",
      ["scripts/nx-quiet.ts", "run", "@pf/drizzle-sqlite:migrate"],
      {
        env: { ...process.env, SQLITE_DATABASE_PATH: dbPath },
        cwd: WORKSPACE_ROOT,
        stdio: "inherit",
      },
    )

    proc.on("exit", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Migration failed with code ${code}`))
      }
    })

    proc.on("error", reject)
  })
}

/**
 * Import organisation to database.
 * When issuerUrl is provided, sets OAUTH_ISSUER_URL so the frontend JWT
 * is created with the correct issuer during import.
 */
const importOrganisation = (
  dbPath: string,
  orgPath: string,
  issuerUrl?: string,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log("[e2e] Importing organisation...")

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SQLITE_DATABASE_PATH: dbPath,
      GOOGLE_CLIENT_ID:
        process.env["GOOGLE_CLIENT_ID"] ?? "ci-google-client-id",
      GOOGLE_CLIENT_SECRET:
        process.env["GOOGLE_CLIENT_SECRET"] ?? "ci-google-client-secret",
      CI_PIPELINE_SECRET:
        process.env["CI_PIPELINE_SECRET"] ?? "test-secret-for-e2e",
    }
    if (issuerUrl) {
      env["OAUTH_ISSUER_URL"] = issuerUrl
    }

    const proc = spawn("bun", ["cli/pfcli/src/main.ts", "import", orgPath], {
      env,
      cwd: WORKSPACE_ROOT,
      stdio: "inherit",
    })

    proc.on("exit", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Import failed with code ${code}`))
      }
    })

    proc.on("error", reject)
  })
}

const readFrontendJwt = (dbPath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    console.log("[e2e] Reading FRONTEND_JWT_TOKEN from database...")

    const proc = spawn(
      "bun",
      ["cli/pfcli/src/main.ts", "get-frontend-jwt", DEMO_ORG_PATH],
      {
        env: { ...process.env, SQLITE_DATABASE_PATH: dbPath },
        cwd: WORKSPACE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on("error", reject)

    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Failed reading FRONTEND_JWT_TOKEN (exit ${code}): ${stderr.trim()}`,
          ),
        )
        return
      }

      const token = stdout.trim()
      if (token.length === 0) {
        reject(new Error("Failed reading FRONTEND_JWT_TOKEN: empty output"))
        return
      }

      resolve(token)
    })
  })
}

/**
 * Kill a server process
 */
const killServer = (server: Server | null) => {
  if (server?.proc?.pid) {
    try {
      process.kill(server.proc.pid, "SIGTERM")
    } catch (err) {
      // ESRCH means process already dead, which is fine
      if (err instanceof Error && "code" in err && err.code !== "ESRCH") {
        console.warn(`[e2e] Failed to kill ${server.name}: ${err.message}`)
      }
    }
  }
}

/**
 * Clean up temp database and associated WAL/SHM files
 */
const cleanupDatabase = (path: string | null) => {
  if (path && existsSync(path)) {
    try {
      unlinkSync(path)
      const walPath = `${path}-wal`
      const shmPath = `${path}-shm`
      if (existsSync(walPath)) unlinkSync(walPath)
      if (existsSync(shmPath)) unlinkSync(shmPath)
      console.log(`[e2e] Deleted temp database: ${path}`)
    } catch (err) {
      console.warn(`[e2e] Failed to delete temp database: ${err}`)
    }
  }
}

const cleanupFile = (path: string | null) => {
  if (path && existsSync(path)) {
    try {
      unlinkSync(path)
    } catch (err) {
      console.warn(`[e2e] Failed to delete temp file ${path}: ${err}`)
    }
  }
}

BeforeAll({ timeout: 120000 }, async () => {
  // Skip local server setup when BASE_URL is provided (testing against external runtime)
  // This includes BASE_URL=http://localhost which reads ports from .graphql-port/.auth-port
  if (process.env["BASE_URL"]) {
    console.log(
      `[e2e] BASE_URL set to ${process.env["BASE_URL"]}, skipping local server setup`,
    )
    return
  }

  try {
    console.log("[e2e] Starting local runtime for e2e tests...")

    lifecycleOrgPath = await prepareLifecycleOrganisation(WORKSPACE_ROOT)
    DEMO_ORG_PATH = lifecycleOrgPath

    // Create unique temp database
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    dbPath = join(tmpdir(), `test-e2e-${timestamp}-${randomSuffix}.db`)
    workerPauseFile = `${dbPath}.worker-pause`
    workerStateFile = `${dbPath}.worker-state.json`
    console.log(`[e2e] Using database: ${dbPath}`)

    // Get available ports for auth and graphql servers upfront
    const authPort = await getAvailablePort()
    const graphqlPort = await getAvailablePort()
    console.log(
      `[e2e] Allocated ports - auth: ${authPort}, graphql: ${graphqlPort}`,
    )

    // Run migrations on empty database
    await runMigrations(dbPath)

    // Import the demo organisation (also runs custom org migrations)
    // Pass issuer URL so the frontend JWT is created with the correct issuer
    await importOrganisation(
      dbPath,
      DEMO_ORG_PATH,
      `http://localhost:${authPort}`,
    )

    const frontendJwtToken = await readFrontendJwt(dbPath)

    // Set up CI_PIPELINE_SECRET for auth
    const ciSecret = process.env["CI_PIPELINE_SECRET"] ?? "test-secret-for-e2e"

    // Start authentication server with explicit port
    // Use ci@example.com for dummy provider - must have a matching invitation in the org
    await startServerOnPort(
      "auth-server",
      "runtime/local/src/authentication-server/authentication-server.ts",
      authPort,
      [],
      {
        SQLITE_DATABASE_PATH: dbPath,
        CI_PIPELINE_SECRET: ciSecret,
        PF_BYPASS_AUTH: "ci@example.com",
        PF_ORG: DEMO_ORG_PATH,
        PF_AUTH_SKIP_M2M_LAST_LOGGED_IN_UPDATE:
          process.env["PF_AUTH_SKIP_M2M_LAST_LOGGED_IN_UPDATE"] ?? "true",
      },
    )
    console.log(`[e2e] Auth server running on port ${authPort}`)

    // Start GraphQL server with explicit port
    // Pass OAUTH_ISSUER_URL so graphql server knows where auth server is
    // Pass INTERNAL_API_SECRET for internal API communication from job worker
    await startServerOnPort(
      "graphql-server",
      "runtime/local/src/graphql-server/graphql-server.ts",
      graphqlPort,
      ["--org", DEMO_ORG_PATH],
      {
        SQLITE_DATABASE_PATH: dbPath,
        CI_PIPELINE_SECRET: ciSecret,
        INTERNAL_API_SECRET: ciSecret,
        OAUTH_ISSUER_URL: `http://localhost:${authPort}`,
        PF_ORG: DEMO_ORG_PATH,
        E2E_SKIP_DELAYS: process.env["E2E_SKIP_DELAYS"] ?? "true",
      },
    )
    console.log(`[e2e] GraphQL server running on port ${graphqlPort}`)

    // Wait for GraphQL server to be ready
    console.log("[e2e] Waiting for GraphQL server to be ready...")
    await waitForServer(`http://localhost:${graphqlPort}/graphql`)

    // Start job worker directly with bun
    // Pass GRAPHQL_SERVER_URL so job worker knows where to publish events
    // Pass INTERNAL_API_SECRET for internal API communication with graphql server
    await startJobWorker(
      "runtime/local/src/job-worker/job-worker.ts",
      ["--org", DEMO_ORG_PATH],
      {
        SQLITE_DATABASE_PATH: dbPath,
        CI_PIPELINE_SECRET: ciSecret,
        INTERNAL_API_SECRET: ciSecret,
        PF_ORG: DEMO_ORG_PATH,
        GRAPHQL_SERVER_URL: `http://localhost:${graphqlPort}`,
        E2E_SKIP_DELAYS: process.env["E2E_SKIP_DELAYS"] ?? "true",
        PF_LOCAL_QUEUE_SUCCESS_DELAY_MS:
          process.env["PF_LOCAL_QUEUE_SUCCESS_DELAY_MS"] ?? "250",
        PF_LOCAL_QUEUE_PAUSE_FILE: workerPauseFile,
        PF_LOCAL_QUEUE_STATE_FILE: workerStateFile,
      },
    )
    console.log("[e2e] Job worker started")

    // Set environment variables for tests to use
    process.env["GRAPHQL_ENDPOINT"] = `http://localhost:${graphqlPort}/graphql`
    process.env["AUTH_URL"] = `http://localhost:${authPort}`
    process.env["CI_PIPELINE_SECRET"] = ciSecret
    process.env["INTERNAL_API_SECRET"] = ciSecret
    process.env["FRONTEND_JWT_TOKEN"] = frontendJwtToken
    process.env["PF_LOCAL_QUEUE_PAUSE_FILE"] = workerPauseFile
    process.env["PF_LOCAL_QUEUE_STATE_FILE"] = workerStateFile

    console.log("[e2e] Local runtime started successfully!")
  } catch (err) {
    console.error("[e2e] BeforeAll failed, cleaning up...")
    killServer(authServer)
    killServer(graphqlServer)
    killServer(jobWorker)
    cleanupFile(workerPauseFile)
    cleanupFile(workerStateFile)
    cleanupDatabase(dbPath)
    await cleanupLifecycleFiles()
    throw err
  }
})

AfterAll({ timeout: 10000 }, async () => {
  // Skip cleanup when using external runtime
  if (process.env["BASE_URL"]) {
    console.log("[e2e] Using external runtime, no cleanup needed")
    return
  }

  console.log("[e2e] Cleaning up local runtime...")

  killServer(authServer)
  killServer(graphqlServer)
  killServer(jobWorker)

  // Give processes time to clean up
  await new Promise((resolve) => setTimeout(resolve, 1000))

  // Clean up temp database
  cleanupFile(workerPauseFile)
  cleanupFile(workerStateFile)
  cleanupDatabase(dbPath)
  await cleanupLifecycleFiles()

  console.log("[e2e] Cleanup complete!")
})

// Restart only the three processes owned by this disposable fixture. Keep the
// same database, queue rows, ports, signing keys and accepted execution IDs.
export const restartLocalRuntime = async (): Promise<void> => {
  if (process.env["BASE_URL"] || !authServer || !graphqlServer || !jobWorker) {
    throw new Error(
      "Runtime restart requires the owned disposable local fixture",
    )
  }
  const servers = [jobWorker, graphqlServer, authServer]
  await withPausedLocalWorker(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.proc.kill("SIGKILL")
          reject(new Error(`${server.name} did not stop within 10 seconds`))
        }, 10_000)
        server.proc.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
        server.proc.kill("SIGTERM")
      })
    }
    for (const server of [...servers].reverse()) await server.restart()
  })
  console.log(`[e2e] Restarted auth, GraphQL and worker against ${dbPath}`)
}

let starterModeRevoked = false
const starterRevocation =
  '\nforbid(principal == PF::ServiceAccount::"ci-pipeline", action == PF::Action::"skipScheduleWaits", resource is PF::Process);\n'
export const setStarterModeRevoked = async (
  revoked: boolean,
): Promise<void> => {
  if (lifecycleOrgPath === null || process.env["BASE_URL"]) {
    throw new Error(
      "Policy changes require the owned disposable lifecycle organisation",
    )
  }
  const path = join(lifecycleOrgPath, "cedar/ci.cedar")
  const policy = (await readFile(path, "utf8")).replace(starterRevocation, "")
  await writeFile(path, policy + (revoked ? starterRevocation : ""))
  starterModeRevoked = revoked
}

After({ tags: "@without-waiting-lifecycle", timeout: 60_000 }, async () => {
  if (starterModeRevoked) {
    await setStarterModeRevoked(false)
    await restartLocalRuntime()
  }
})

Before({ tags: "@localhost-only" }, () => {
  if (process.env["BASE_URL"]) return "skipped"
  return undefined
})

const originalSkipDelays = process.env["E2E_SKIP_DELAYS"] ?? "true"
Before({ timeout: 60_000 }, async ({ pickle }) => {
  if (process.env["BASE_URL"]) return
  const lifecycle = pickle.tags.some(
    (tag) => tag.name === "@without-waiting-lifecycle",
  )
  const skipDelays = lifecycle ? "false" : originalSkipDelays
  if ((process.env["E2E_SKIP_DELAYS"] ?? "true") !== skipDelays) {
    process.env["E2E_SKIP_DELAYS"] = skipDelays
    await restartLocalRuntime()
  }
})
