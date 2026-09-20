import { readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Request, expect } from "@playwright/test"
import { createBdd } from "playwright-bdd"
import { test } from "./fixtures"

const { Before, After } = createBdd(test)
let resumeWorker: ((assertCompleted: boolean) => void) | undefined

// Opt-in Linux fault injection against our disposable runtime, never a shared org.
Before({ tags: "@todo-completion" }, async ({ page }) => {
  const configuredPid = process.env["FRONTEND_E2E_COMPLETION_WORKER_PID"]
  if (!configuredPid) return
  const pid = Number(configuredPid)
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Expected a positive local worker PID")
  }
  const base = new URL(process.env["BASE_URL"] ?? "http://invalid")
  const root = resolve(__dirname, "../../../..")
  const proc = `/proc/${pid}`
  const env = new Map(
    readFileSync(join(proc, "environ"), "utf8")
      .split("\0")
      .map((entry) => {
        const separator = entry.indexOf("=")
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      }),
  )
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(base.hostname) ||
    realpathSync(join(proc, "cwd")) !== root ||
    env.get("FRONTEND_PORT") !== base.port ||
    !env.get("PF_ORG")?.startsWith(join(tmpdir(), "pf-temp-org-demo-")) ||
    !readFileSync(join(proc, "cmdline"), "utf8")
      .split("\0")
      .includes("runtime/local/src/job-worker/job-worker.ts")
  ) {
    throw new Error(
      "Backlog probe requires this worktree's disposable demo worker",
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let state: "waiting" | "paused" | "resumed" = "waiting"
  const signalErrors: unknown[] = []
  const signalWorker = (signal: "SIGSTOP" | "SIGCONT") => {
    try {
      process.kill(pid, signal)
      return true
    } catch (error) {
      signalErrors.push(error)
      return false
    }
  }
  const pauseOnStart = (request: Request) => {
    if (!request.postData()?.includes("mutation StartProcess")) return
    page.off("request", pauseOnStart)
    if (!signalWorker("SIGSTOP")) return
    state = "paused"
    timer = setTimeout(() => {
      if (signalWorker("SIGCONT")) state = "resumed"
    }, 35_000)
  }
  resumeWorker = (assertCompleted) => {
    page.off("request", pauseOnStart)
    clearTimeout(timer)
    signalWorker("SIGCONT")
    if (signalErrors.length > 0) {
      throw new AggregateError(
        signalErrors,
        "Backlog probe worker signal failed",
      )
    }
    if (assertCompleted) {
      expect(
        state,
        "Backlog probe must pause and resume after 35 seconds",
      ).toBe("resumed")
    }
  }
  page.on("request", pauseOnStart)
  // CI authentication consumed 32.65s before any process navigation.
  await new Promise((done) => setTimeout(done, 33_000))
})

After({ tags: "@todo-completion" }, async ({ $testInfo }) => {
  try {
    resumeWorker?.($testInfo.status === "passed")
  } finally {
    resumeWorker = undefined
  }
})
