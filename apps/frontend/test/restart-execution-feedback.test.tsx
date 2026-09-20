import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { RestartExecutionFeedback } from "../app/(protected)/executions/restart-execution-feedback"
import { RESTART_EXECUTION_PENDING_LABEL } from "../lib/restart-execution-action"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

describe("RestartExecutionFeedback", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
  })

  test("renders nothing when idle", async () => {
    await act(async () => {
      root.render(
        <RestartExecutionFeedback isRestarting={false} outcome={null} />,
      )
    })

    expect(
      container.querySelector('[data-testid="restart-execution-feedback"]'),
    ).toBeNull()
  })

  test("presents an accessible pending state", async () => {
    await act(async () => {
      root.render(
        <RestartExecutionFeedback isRestarting={true} outcome={null} />,
      )
    })

    const feedback = container.querySelector(
      '[data-testid="restart-execution-feedback"]',
    )
    expect(feedback).not.toBeNull()
    expect(feedback?.getAttribute("role")).toBe("status")
    expect(feedback?.getAttribute("aria-live")).toBe("polite")
    expect(feedback?.getAttribute("aria-busy")).toBe("true")
    expect(feedback?.textContent).toBe(RESTART_EXECUTION_PENDING_LABEL)
  })

  test("presents a visible success confirmation", async () => {
    await act(async () => {
      root.render(
        <RestartExecutionFeedback
          isRestarting={false}
          outcome={{
            type: "success",
            message: "Restarted 2 failed step(s)",
          }}
        />,
      )
    })

    const feedback = container.querySelector(
      '[data-testid="restart-execution-feedback"]',
    )
    expect(feedback?.getAttribute("role")).toBe("status")
    expect(feedback?.getAttribute("aria-busy")).toBe("false")
    expect(feedback?.textContent).toBe("Restarted 2 failed step(s)")
  })

  test("presents a resolver error as an alert", async () => {
    await act(async () => {
      root.render(
        <RestartExecutionFeedback
          isRestarting={false}
          outcome={{
            type: "error",
            message: "No failed todos found for this execution",
          }}
        />,
      )
    })

    const feedback = container.querySelector(
      '[data-testid="restart-execution-feedback"]',
    )
    expect(feedback?.getAttribute("role")).toBe("alert")
    expect(feedback?.getAttribute("aria-live")).toBe("assertive")
    expect(feedback?.textContent).toBe(
      "No failed todos found for this execution",
    )
  })
})

const installDom = (): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>")
  const previousGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
  }
  const previousActEnvironment = {
    hasValue: "IS_REACT_ACT_ENVIRONMENT" in globalThis,
    value: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    if (previousActEnvironment.hasValue) {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment.value
    } else {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT
    }
  }
}
