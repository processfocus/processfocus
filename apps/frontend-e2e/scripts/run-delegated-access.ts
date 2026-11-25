#!/usr/bin/env bun

import { spawn } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const org = mkdtempSync(join(tmpdir(), "pf-delegation-e2e-"))
const portFiles = [
  ".auth-port.json",
  ".graphql-port.json",
  ".frontend-port.json",
].map((name) => {
  const path = join(root, name)
  return { path, previous: existsSync(path) ? readFileSync(path) : undefined }
})
// Nx tasks create separate process groups. Match the unique inherited fixture
// marker so cancellation also cleans up detached runtime/Next descendants.
const runtimePids = () =>
  readdirSync("/proc").flatMap((pid) => {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return []
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(`PF_ORG=${org}`)
        ? [Number(pid)]
        : []
    } catch {
      return []
    }
  })
const killRuntime = (signal: NodeJS.Signals) => {
  for (const pid of runtimePids()) {
    try {
      process.kill(pid, signal)
    } catch {
      /* Already exited. */
    }
  }
}
let child: ReturnType<typeof spawn> | undefined
const stop = () => {
  killRuntime("SIGTERM")
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      // The process group has already exited.
    }
  }
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const freePort = async (): Promise<string> => {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, done)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No local port")
  const port = String(address.port)
  await new Promise<void>((done) => server.close(() => done()))
  return port
}
try {
  const port = await freePort()
  const authPort = await freePort()
  cpSync(join(root, "examples/demo"), org, { recursive: true })
  rmSync(join(org, "db"), { recursive: true, force: true })
  rmSync(join(org, "dist"), { recursive: true, force: true })
  const source = join(org, "src/org.ts")
  writeFileSync(
    source,
    readFileSync(source, "utf8")
      .replace(
        'origin: "http://localhost:3000"',
        `origin: "http://localhost:${port}"`,
      )
      .replaceAll(
        "roles: [employee, administrator]",
        "roles: [employee, administrator, finance_manager]",
      ),
  )
  const env = { ...process.env }
  // No inherited deployed endpoints or shared database may select the runtime.
  for (const key of [
    "BASE_URL",
    "GRAPHQL_ENDPOINT",
    "OAUTH_ISSUER_URL",
    "NX_INVOCATION_ROOT_PID",
    "FRONTEND_E2E_INVITATION_EMAIL",
  ])
    delete env[key]
  child = spawn(
    "bun",
    [
      "scripts/nx-quiet.ts",
      "run",
      "@pf/frontend-e2e:e2e",
      "--retries=0",
      "--workers=1",
    ],
    {
      cwd: root,
      detached: true,
      stdio: "inherit",
      env: {
        ...env,
        PF_ORG: org,
        PF_RUNTIME_ROOT: root,
        PF_TEMP_ORG_NODE_MODULES: join(root, "node_modules"),
        SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
        FRONTEND_E2E_DISPOSABLE_ORG: org,
        FRONTEND_E2E_PORT: port,
        FRONTEND_BASE_URL: `http://localhost:${port}`,
        PF_LOCAL_FRONTEND_ORIGIN: `http://localhost:${port}`,
        // Pin the same issuer for import, auth and GraphQL even when the
        // machine already runs an unrelated local Process Focus issuer.
        PORT: authPort,
        OAUTH_ISSUER_URL: `http://localhost:${authPort}`,
        INTERNAL_API_SECRET: crypto.randomUUID(),
        FRONTEND_E2E_FEATURES:
          process.env["FRONTEND_E2E_FEATURES"] ??
          "./src/{features-delegated-access,features-passkey}/*.feature",
        FRONTEND_E2E_BROWSERS: "chromium",
        FRONTEND_E2E_SERVER_COMMAND:
          "env -u NX_INVOCATION_ROOT_PID bun scripts/nx-quiet.ts run @processfocus/runtime-local:serve",
        PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
        GOOGLE_CLIENT_ID: "ci-google-client-id",
        GOOGLE_CLIENT_SECRET: "ci-google-client-secret",
        CI_PIPELINE_SECRET: "ci-pipeline-secret",
        RESEND_ENABLED: "false",
        E2E_SKIP_DELAYS: "true",
        NX_DAEMON: "false",
      },
    },
  )
  process.exitCode = await new Promise<number>((done, reject) => {
    child?.once("error", reject)
    child?.once("exit", (code) => done(code ?? 1))
  })
} finally {
  stop()
  const deadline = Date.now() + 5_000
  while (runtimePids().length && Date.now() < deadline) await Bun.sleep(100)
  killRuntime("SIGKILL")
  for (const { path, previous } of portFiles) {
    if (previous) writeFileSync(path, previous)
    else rmSync(path, { force: true })
  }
  rmSync(org, { recursive: true, force: true })
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
}
