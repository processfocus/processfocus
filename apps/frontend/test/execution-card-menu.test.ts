import {
  ABANDON_EXECUTION_CONFIRM_LABEL,
  ABANDON_EXECUTION_DIALOG_DESCRIPTION,
  ABANDON_EXECUTION_DIALOG_TITLE,
  ABANDON_EXECUTION_FAILED_MESSAGE,
  ABANDON_EXECUTION_PENDING_LABEL,
  ABANDON_EXECUTION_REASON_PLACEHOLDER,
} from "../app/(protected)/executions/abandon-execution-dialog"
import {
  canShowAbandonExecution,
  shouldRenderExecutionCardMenu,
} from "../app/(protected)/executions/execution-card-menu"
import { describe, expect, test } from "bun:test"

describe("shouldRenderExecutionCardMenu", () => {
  test("hides the shell when idle with no menu actions", () => {
    expect(
      shouldRenderExecutionCardMenu({
        hasMenuActions: false,
        isRestarting: false,
        restartOutcome: null,
      }),
    ).toBe(false)
  })

  test("keeps the shell for menu actions even without feedback", () => {
    expect(
      shouldRenderExecutionCardMenu({
        hasMenuActions: true,
        isRestarting: false,
        restartOutcome: null,
      }),
    ).toBe(true)
  })

  test("keeps the shell while restart is pending without menu actions", () => {
    expect(
      shouldRenderExecutionCardMenu({
        hasMenuActions: false,
        isRestarting: true,
        restartOutcome: null,
      }),
    ).toBe(true)
  })

  test("keeps success feedback after status leaves Failed and menu actions drop", () => {
    // After a successful restart, live execution status may leave Failed and
    // canShowRestartExecution becomes false. Restart-only menus then have no
    // actions, but the outcome must still be visible without RxDB dependence.
    expect(
      shouldRenderExecutionCardMenu({
        hasMenuActions: false,
        isRestarting: false,
        restartOutcome: {
          type: "success",
          message: "Restarted 2 failed step(s)",
        },
      }),
    ).toBe(true)
  })

  test("keeps resolver error feedback when menu actions drop", () => {
    expect(
      shouldRenderExecutionCardMenu({
        hasMenuActions: false,
        isRestarting: false,
        restartOutcome: {
          type: "error",
          message: "No failed todos found for this execution",
        },
      }),
    ).toBe(true)
  })
})

describe("abandon execution copy", () => {
  test("uses Cancel execution wording instead of Stop", () => {
    expect(ABANDON_EXECUTION_DIALOG_TITLE).toBe("Cancel execution")
    expect(ABANDON_EXECUTION_CONFIRM_LABEL).toBe("Cancel execution")
    expect(ABANDON_EXECUTION_PENDING_LABEL).toBe("Cancelling...")
    expect(ABANDON_EXECUTION_DIALOG_DESCRIPTION.toLowerCase()).toContain(
      "cancel",
    )
    expect(ABANDON_EXECUTION_REASON_PLACEHOLDER).toBe(
      "Why are you cancelling this execution?",
    )
    expect(ABANDON_EXECUTION_FAILED_MESSAGE).toBe("Failed to cancel execution")
    expect(ABANDON_EXECUTION_DIALOG_TITLE.toLowerCase()).not.toContain("stop")
    expect(ABANDON_EXECUTION_CONFIRM_LABEL.toLowerCase()).not.toContain("stop")
    expect(ABANDON_EXECUTION_PENDING_LABEL.toLowerCase()).not.toContain("stop")
    expect(ABANDON_EXECUTION_REASON_PLACEHOLDER.toLowerCase()).not.toContain(
      "stop",
    )
    expect(ABANDON_EXECUTION_FAILED_MESSAGE.toLowerCase()).not.toContain("stop")
  })
})

describe("canShowAbandonExecution", () => {
  test("shows abandon for authorized Running and Failed executions", () => {
    expect(
      canShowAbandonExecution({
        status: "Running",
        canAbandonExecution: true,
      }),
    ).toBe(true)
    expect(
      canShowAbandonExecution({
        status: "Failed",
        canAbandonExecution: true,
      }),
    ).toBe(true)
  })

  test("hides abandon for Completed, Abandoned, and unauthorized executions", () => {
    expect(
      canShowAbandonExecution({
        status: "Completed",
        canAbandonExecution: true,
      }),
    ).toBe(false)
    expect(
      canShowAbandonExecution({
        status: "Abandoned",
        canAbandonExecution: true,
      }),
    ).toBe(false)
    expect(
      canShowAbandonExecution({
        status: "Failed",
        canAbandonExecution: false,
      }),
    ).toBe(false)
    expect(
      canShowAbandonExecution({
        status: "Running",
        canAbandonExecution: false,
      }),
    ).toBe(false)
  })
})
