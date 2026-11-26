import { Effect, Result } from "effect"
import type {
  ExecutionEventSource,
  ExecutionSnapshot,
  ExecutionStatus,
} from "../src/utils/execution-subscription"
import { waitForExecutionToFinish } from "../src/utils/execution-wait"
import { describe, expect, it, spyOn } from "bun:test"

const snapshot = (
  status: ExecutionStatus,
  id = "exec-1",
): ExecutionSnapshot => ({
  id,
  status,
  failureReason: null,
  abandonedReason: null,
  finishedAt: null,
  steps: [],
})

const silentSource = (): ExecutionEventSource => ({
  close: async () => undefined,
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<ExecutionSnapshot>>(() => {}),
  }),
})

const endedSource = (): ExecutionEventSource => ({
  close: async () => undefined,
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: undefined }),
  }),
})

const manualSource = () => {
  const events: ExecutionSnapshot[] = []
  const pending: ((result: IteratorResult<ExecutionSnapshot>) => void)[] = []
  const source: ExecutionEventSource = {
    close: async () => undefined,
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = events.shift()
        return value
          ? Promise.resolve({ done: false, value })
          : new Promise<IteratorResult<ExecutionSnapshot>>((resolve) => {
              pending.push(resolve)
            })
      },
    }),
  }
  return {
    source,
    push(value: ExecutionSnapshot) {
      const resolve = pending.shift()
      if (resolve) {
        resolve({ done: false, value })
      } else {
        events.push(value)
      }
    },
  }
}

const run = Effect.runPromise

describe("waitForExecutionToFinish snapshot recovery", () => {
  it.each([false, true])(
    "measures inactivity from the last matching update, ignoring recovery, unrelated IDs and heartbeats (matching=%p)",
    async (matching) => {
      let now = 0
      const clock = spyOn(Date, "now").mockImplementation(() => now)
      const output = spyOn(process.stdout, "write").mockImplementation(
        () => true,
      )
      const messages: string[] = []
      let reads = 0
      let polls = 0
      const source: ExecutionEventSource = {
        close: async () => undefined,
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            reads++
            now = (reads === 1 ? 10 : 10 + reads) * 60_000
            return {
              done: false,
              value: snapshot(
                "Running",
                matching && reads === 1 ? "exec-1" : "other",
              ),
            }
          },
        }),
      }
      try {
        const result = await run(
          waitForExecutionToFinish(source, "exec-1", {
            executionLabel: "deployment",
            timeoutMs: 60_000,
            heartbeatMs: 1,
            maxWaitMs: 60 * 60_000,
            hasPendingInitialLine: false,
            formatLogMessage: (message) => {
              messages.push(message)
              return message
            },
            fetchSnapshot: async () => {
              polls++
              return snapshot(
                polls === (matching ? 3 : 4) ? "Completed" : "Running",
              )
            },
          }),
        )
        expect(result.status).toBe("Completed")
        expect(output.mock.calls.some(([text]) => text === ".")).toBe(true)
        expect(
          messages.filter((message) => message.startsWith("No deployment")),
        ).toEqual(
          (matching ? [2, 4] : [10, 12, 14]).map(
            (minutes) =>
              `No deployment updates for ${minutes} minutes; deployment is still Running; continuing to wait.`,
          ),
        )
      } finally {
        clock.mockRestore()
        output.mockRestore()
      }
    },
  )

  it.each([silentSource, endedSource])(
    "returns the persisted snapshot after live updates stop (%p)",
    async (source) => {
      let snapshotFetches = 0
      const terminal = await run(
        waitForExecutionToFinish(source(), "exec-1", {
          executionLabel: "test execution",
          timeoutMs: 80,
          heartbeatMs: 60_000,
          hasPendingInitialLine: false,
          formatLogMessage: (message) => message,
          quiet: true,
          includeExecutionIdInTimeout: true,
          fetchSnapshot: () => {
            snapshotFetches += 1
            return Promise.resolve(snapshot("Completed"))
          },
          maxWaitMs: 5_000,
        }),
      )

      expect(terminal.status).toBe("Completed")
      expect(snapshotFetches).toBe(1)
    },
  )

  it.each([false, true])(
    "keeps waiting while the snapshot reports running and finishes from a later event (unrelated event=%p)",
    async (unrelatedEvent) => {
      let snapshotFetches = 0
      const { source, push } = manualSource()
      const wait = run(
        waitForExecutionToFinish(source, "exec-1", {
          executionLabel: "test execution",
          timeoutMs: 80,
          heartbeatMs: 60_000,
          hasPendingInitialLine: false,
          formatLogMessage: (message) => message,
          quiet: true,
          includeExecutionIdInTimeout: true,
          fetchSnapshot: () => {
            snapshotFetches += 1
            return Promise.resolve(snapshot("Running"))
          },
          maxWaitMs: 5_000,
        }),
      )

      await new Promise((resolve) => setTimeout(resolve, 200))
      if (unrelatedEvent) push(snapshot("Completed", "another-execution"))
      push(snapshot("Completed"))
      const terminal = await wait

      expect(terminal.status).toBe("Completed")
      expect(snapshotFetches).toBeGreaterThanOrEqual(1)
    },
  )

  it.each([silentSource, endedSource])(
    "bounds running executions after live updates stop (%p)",
    async (source) => {
      let snapshotFetches = 0
      const error: unknown = await run(
        waitForExecutionToFinish(source(), "exec-1", {
          executionLabel: "test execution",
          timeoutMs: 60,
          heartbeatMs: 60_000,
          hasPendingInitialLine: false,
          formatLogMessage: (message) => message,
          quiet: true,
          includeExecutionIdInTimeout: true,
          fetchSnapshot: () => {
            snapshotFetches += 1
            return Promise.resolve(snapshot("Running"))
          },
          maxWaitMs: 150,
        }),
      ).then(
        () => undefined,
        (value) => value,
      )

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(
        "Timeout: No test execution update received",
      )
      expect(String(error)).toContain("was still Running")
      expect(snapshotFetches).toBeGreaterThan(1)
    },
  )

  it("fails with the plain timeout when no snapshot fetcher is configured", async () => {
    const error: unknown = await run(
      waitForExecutionToFinish(silentSource(), "exec-1", {
        executionLabel: "test execution",
        timeoutMs: 60,
        heartbeatMs: 60_000,
        hasPendingInitialLine: false,
        formatLogMessage: (message) => message,
        quiet: true,
        includeExecutionIdInTimeout: true,
      }),
    ).then(
      () => undefined,
      (value) => value,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(
      "Timeout: No test execution update received in the last 0 minutes for test execution exec-1",
    )
  })

  it.each([silentSource, endedSource])(
    "bounds persistent snapshot failures and retains their cause (%p)",
    async (source) => {
      const cause = new Error("snapshot service unavailable")
      const controller = new AbortController()
      const watchdog = setTimeout(() => controller.abort(), 600)
      let snapshotFetches = 0
      const messages: string[] = []
      try {
        const result = await Effect.runPromise(
          Effect.result(
            waitForExecutionToFinish(source(), "exec-1", {
              executionLabel: "test execution",
              timeoutMs: 40,
              heartbeatMs: 60_000,
              hasPendingInitialLine: false,
              formatLogMessage: (message) => {
                messages.push(message)
                return message
              },
              quiet: true,
              fetchSnapshot: () => {
                snapshotFetches += 1
                return Promise.reject(cause)
              },
              maxWaitMs: 100,
            }),
          ),
          { signal: controller.signal },
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("Timeout:")
          expect(result.failure.message).toContain(
            "could not read test execution exec-1 status",
          )
          expect(result.failure.cause).toBeInstanceOf(Error)
          if (result.failure.cause instanceof Error) {
            expect(result.failure.cause.cause).toBe(cause)
          }
        }
        expect(snapshotFetches).toBeGreaterThan(1)
        expect(
          messages.filter((message) => message.startsWith("Could not read")),
        ).toHaveLength(1)
      } finally {
        clearTimeout(watchdog)
        controller.abort()
      }
    },
  )

  it("keeps waiting when the snapshot query fails transiently", async () => {
    let snapshotFetches = 0
    const terminal = await run(
      waitForExecutionToFinish(silentSource(), "exec-1", {
        executionLabel: "test execution",
        timeoutMs: 60,
        heartbeatMs: 60_000,
        hasPendingInitialLine: false,
        formatLogMessage: (message) => message,
        quiet: true,
        includeExecutionIdInTimeout: true,
        fetchSnapshot: () => {
          snapshotFetches += 1
          if (snapshotFetches === 1) {
            return Promise.reject(new Error("graphql request failed"))
          }
          return Promise.resolve(snapshot("Completed"))
        },
        maxWaitMs: 5_000,
      }),
    )

    expect(terminal.status).toBe("Completed")
    expect(snapshotFetches).toBe(2)
  })

  it("still fails when the stream ends without a snapshot fetcher", async () => {
    const error: unknown = await run(
      waitForExecutionToFinish(endedSource(), "exec-1", {
        executionLabel: "test execution",
        timeoutMs: 60,
        heartbeatMs: 60_000,
        hasPendingInitialLine: false,
        formatLogMessage: (message) => message,
        quiet: true,
      }),
    ).then(
      () => undefined,
      (value) => value,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(
      "Execution update stream ended before test execution finished: exec-1",
    )
  })

  it("cancels disconnected polling without waiting for the next poll", async () => {
    const controller = new AbortController()
    const fetched = Promise.withResolvers<void>()
    const wait = run(
      waitForExecutionToFinish(endedSource(), "exec-1", {
        executionLabel: "test execution",
        timeoutMs: 60_000,
        heartbeatMs: 60_000,
        hasPendingInitialLine: false,
        formatLogMessage: (message) => message,
        quiet: true,
        fetchSnapshot: async () => {
          fetched.resolve()
          return snapshot("Running")
        },
      }),
      { signal: controller.signal },
    )
    try {
      await fetched.promise
      controller.abort()
      await expect(wait).rejects.toThrow()
    } finally {
      controller.abort()
    }
  }, 1_000)

  it.each([false, true])(
    "renders persisted progress after stream cleanup fails (quiet=%p)",
    async (quiet) => {
      const source = endedSource()
      const messages: string[] = []
      const statuses: ExecutionStatus[] = ["Running", "Waiting", "Completed"]
      const terminal = await run(
        waitForExecutionToFinish(
          {
            ...source,
            close: async () => {
              throw new Error("socket cleanup failed")
            },
          },
          "exec-1",
          {
            executionLabel: "test execution",
            timeoutMs: 20,
            heartbeatMs: 60_000,
            maxWaitMs: 1_000,
            hasPendingInitialLine: false,
            quiet,
            formatLogMessage: (message) => {
              messages.push(message)
              return message
            },
            fetchSnapshot: async () => snapshot(statuses.shift() ?? "Failed"),
          },
        ),
      )
      expect(terminal.status).toBe("Completed")
      expect(messages.join("\n")).toContain("socket cleanup failed")
      const progress = messages.filter((message) =>
        message.startsWith("Status:"),
      )
      expect(progress).toEqual(
        quiet
          ? []
          : [
              "Status: Running",
              "Status: Running -> Waiting",
              "Status: Waiting -> Completed",
            ],
      )
    },
  )
})
