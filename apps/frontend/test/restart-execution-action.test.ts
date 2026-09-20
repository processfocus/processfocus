import {
  RESTART_EXECUTION_GENERIC_ERROR,
  type RestartExecutionMutationResult,
  type RestartExecutionOutcome,
  formatRestartFailureMessage,
  formatRestartSuccessMessage,
  runRestartExecution,
} from "../lib/restart-execution-action"
import { describe, expect, mock, test } from "bun:test"

describe("formatRestartSuccessMessage", () => {
  test("includes the restarted-step count when available", () => {
    expect(formatRestartSuccessMessage(3)).toBe("Restarted 3 failed step(s)")
    expect(formatRestartSuccessMessage(0)).toBe("Restarted 0 failed step(s)")
  })

  test("uses a generic success message when count is unavailable", () => {
    expect(formatRestartSuccessMessage(undefined)).toBe(
      "Execution restarted successfully",
    )
    expect(formatRestartSuccessMessage(null)).toBe(
      "Execution restarted successfully",
    )
  })
})

describe("formatRestartFailureMessage", () => {
  test("prefers the resolver-provided error", () => {
    expect(
      formatRestartFailureMessage("No failed todos found for this execution"),
    ).toBe("No failed todos found for this execution")
  })

  test("falls back to a safe generic error", () => {
    expect(formatRestartFailureMessage(undefined)).toBe(
      RESTART_EXECUTION_GENERIC_ERROR,
    )
    expect(formatRestartFailureMessage(null)).toBe(
      RESTART_EXECUTION_GENERIC_ERROR,
    )
    expect(formatRestartFailureMessage("")).toBe(
      RESTART_EXECUTION_GENERIC_ERROR,
    )
  })
})

describe("runRestartExecution", () => {
  test("reports success with restarted-step count", async () => {
    const pendingChanges: boolean[] = []
    let outcome: RestartExecutionOutcome | null = null

    await runRestartExecution({
      isPending: false,
      restart: async () => ({
        success: true,
        restartedCount: 2,
        error: null,
      }),
      onPendingChange: (pending) => {
        pendingChanges.push(pending)
      },
      onOutcome: (next) => {
        outcome = next
      },
    })

    expect(pendingChanges).toEqual([true, false])
    expect(outcome).toEqual({
      type: "success",
      message: "Restarted 2 failed step(s)",
    })
  })

  test("presents resolver failure errors to the user", async () => {
    let outcome: RestartExecutionOutcome | null = null

    await runRestartExecution({
      isPending: false,
      restart: async () => ({
        success: false,
        restartedCount: 0,
        error: "No failed todos found for this execution",
      }),
      onPendingChange: () => undefined,
      onOutcome: (next) => {
        outcome = next
      },
    })

    expect(outcome).toEqual({
      type: "error",
      message: "No failed todos found for this execution",
    })
  })

  test("presents a safe generic error for thrown request failures", async () => {
    let outcome: RestartExecutionOutcome | null = null
    const pendingChanges: boolean[] = []

    await runRestartExecution({
      isPending: false,
      restart: async () => {
        throw new Error("network down")
      },
      onPendingChange: (pending) => {
        pendingChanges.push(pending)
      },
      onOutcome: (next) => {
        outcome = next
      },
    })

    expect(pendingChanges).toEqual([true, false])
    expect(outcome).toEqual({
      type: "error",
      message: RESTART_EXECUTION_GENERIC_ERROR,
    })
  })

  test("clears pending in finally after every outcome", async () => {
    const cases: Array<() => Promise<RestartExecutionMutationResult>> = [
      async () => ({ success: true, restartedCount: 1 }),
      async () => ({
        success: false,
        error: "Not authorized to restart this execution",
      }),
      async () => {
        throw new Error("boom")
      },
    ]

    for (const restart of cases) {
      const pendingChanges: boolean[] = []
      await runRestartExecution({
        isPending: false,
        restart,
        onPendingChange: (pending) => {
          pendingChanges.push(pending)
        },
        onOutcome: () => undefined,
      })
      expect(pendingChanges).toEqual([true, false])
    }
  })

  test("sets pending immediately before awaiting the mutation", async () => {
    let resolveRestart!: (value: RestartExecutionMutationResult) => void
    const restartPromise = new Promise<RestartExecutionMutationResult>(
      (resolve) => {
        resolveRestart = resolve
      },
    )
    const pendingChanges: boolean[] = []
    let sawPendingBeforeResolve = false

    const runPromise = runRestartExecution({
      isPending: false,
      restart: () => restartPromise,
      onPendingChange: (pending) => {
        pendingChanges.push(pending)
        if (pending) {
          sawPendingBeforeResolve = true
        }
      },
      onOutcome: () => undefined,
    })

    expect(sawPendingBeforeResolve).toBe(true)
    expect(pendingChanges).toEqual([true])

    resolveRestart({ success: true, restartedCount: 1 })
    await runPromise

    expect(pendingChanges).toEqual([true, false])
  })

  test("prevents duplicate submissions while pending", async () => {
    const restart = mock(async () => ({
      success: true,
      restartedCount: 1,
    }))
    const pendingChanges: boolean[] = []
    let outcomes = 0

    const first = runRestartExecution({
      isPending: false,
      restart,
      onPendingChange: (pending) => {
        pendingChanges.push(pending)
      },
      onOutcome: () => {
        outcomes += 1
      },
    })

    // Second call while the first is still pending must be ignored.
    await runRestartExecution({
      isPending: true,
      restart,
      onPendingChange: (pending) => {
        pendingChanges.push(pending)
      },
      onOutcome: () => {
        outcomes += 1
      },
    })

    await first

    expect(restart).toHaveBeenCalledTimes(1)
    expect(outcomes).toBe(1)
    expect(pendingChanges).toEqual([true, false])
  })
})
