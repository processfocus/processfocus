import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isGraphqlMutation, withPausedLocalWorker } from "./local-worker-pause"
import { describe, expect, it } from "bun:test"

const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

const waitForPauseToken = async (pauseFile: string): Promise<string> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(pauseFile)) {
      return readFileSync(pauseFile, "utf8").trim()
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error("Timed out waiting for pause file")
}

describe("isGraphqlMutation", () => {
  it("detects GraphQL mutation operations", () => {
    expect(isGraphqlMutation("mutation StartProcess { start }")).toBe(true)
    expect(
      isGraphqlMutation("  mutation($input: Input!) { update(input: $input) }"),
    ).toBe(true)
    expect(
      isGraphqlMutation("mutation{ cleanupExecutions { jobsDeleted } }"),
    ).toBe(true)
  })

  it("does not match non-mutation operations or fields named mutation", () => {
    expect(isGraphqlMutation("query Todos { todos { id } }")).toBe(false)
    expect(
      isGraphqlMutation("subscription TodoUpdates { todoUpdates { id } }"),
    ).toBe(false)
    expect(isGraphqlMutation("query { mutation { id } }")).toBe(false)
  })
})

describe("withPausedLocalWorker", () => {
  it("keeps the pause file while overlapping paused operations are active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-worker-pause-"))
    const pauseFile = join(dir, "worker.pause")
    const stateFile = join(dir, "worker-state.json")
    const previousPauseFile = process.env["PF_LOCAL_QUEUE_PAUSE_FILE"]
    const previousStateFile = process.env["PF_LOCAL_QUEUE_STATE_FILE"]
    const firstStarted = deferred()
    const secondStarted = deferred()
    const firstCanFinish = deferred()
    const secondCanFinish = deferred()

    try {
      process.env["PF_LOCAL_QUEUE_PAUSE_FILE"] = pauseFile
      process.env["PF_LOCAL_QUEUE_STATE_FILE"] = stateFile

      const first = withPausedLocalWorker(async () => {
        firstStarted.resolve()
        await firstCanFinish.promise
      })
      const pauseToken = await waitForPauseToken(pauseFile)
      writeFileSync(
        stateFile,
        `${JSON.stringify({ activeJobs: 0, paused: true, pauseToken })}\n`,
        "utf8",
      )

      const second = withPausedLocalWorker(async () => {
        secondStarted.resolve()
        await secondCanFinish.promise
      })

      await Promise.all([firstStarted.promise, secondStarted.promise])
      expect(existsSync(pauseFile)).toBe(true)

      firstCanFinish.resolve()
      await first
      expect(existsSync(pauseFile)).toBe(true)

      secondCanFinish.resolve()
      await second
      expect(existsSync(pauseFile)).toBe(false)
    } finally {
      firstCanFinish.resolve()
      secondCanFinish.resolve()
      if (previousPauseFile === undefined) {
        delete process.env["PF_LOCAL_QUEUE_PAUSE_FILE"]
      } else {
        process.env["PF_LOCAL_QUEUE_PAUSE_FILE"] = previousPauseFile
      }
      if (previousStateFile === undefined) {
        delete process.env["PF_LOCAL_QUEUE_STATE_FILE"]
      } else {
        process.env["PF_LOCAL_QUEUE_STATE_FILE"] = previousStateFile
      }
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
