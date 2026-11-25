import { spawn } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"

const command = process.env["FRONTEND_E2E_RUNTIME_COMMAND"]
if (!command) throw new Error("Expected frontend E2E runtime command")

const owner = `FRONTEND_E2E_RUNTIME_OWNER=${process.pid}`
const runtimePids = (): number[] => {
  if (process.platform !== "linux") return []
  return readdirSync("/proc").flatMap((pid) => {
    if (!/^\d+$/.test(pid)) return []
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(owner)
        ? [Number(pid)]
        : []
    } catch {
      return []
    }
  })
}

const runtime = spawn(command, {
  shell: true,
  detached: true,
  stdio: "inherit",
  env: {
    ...process.env,
    FRONTEND_E2E_RUNTIME_OWNER: String(process.pid),
    NX_QUIET_INHERIT: "1",
    PLAYWRIGHT_BDD_CONFIGS: undefined,
  },
})

let shutdown: Promise<void> | undefined
const stop = () => {
  if (shutdown) return shutdown
  shutdown = (async () => {
    if (runtime.pid) {
      try {
        process.kill(-runtime.pid, "SIGTERM")
      } catch {
        // The shell may already have exited.
      }
    }
    // Nx continuous tasks escape their launcher's process group. Select only
    // this invocation's descendants, including Next's separate server process.
    for (const pid of runtimePids()) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // Already exited.
      }
    }
    const deadline = Date.now() + 3_000
    while (runtimePids().length && Date.now() < deadline) await Bun.sleep(100)
    for (const pid of runtimePids()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Already exited.
      }
    }
  })()
  return shutdown
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
try {
  process.exitCode = await new Promise<number>((resolve, reject) => {
    runtime.once("error", reject)
    runtime.once("exit", (code) => resolve(code ?? 1))
  })
} finally {
  await stop()
}
