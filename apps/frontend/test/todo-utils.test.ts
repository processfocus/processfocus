import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { computeTodoStatus, useOverdueRefresh } from "../lib/todo-utils"

const NOW = new Date("2026-05-20T12:00:00.000Z").getTime()

const stubGlobal = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  })
}

const restoreGlobal = (key: string, value: unknown) => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key)
    return
  }

  stubGlobal(key, value)
}

describe("computeTodoStatus", () => {
  test("preserves completed todos instead of deriving due-date status", () => {
    expect(computeTodoStatus(null, "Completed")).toBe("Completed")
    expect(computeTodoStatus("2026-05-19T12:00:00.000Z", "Completed")).toBe(
      "Completed",
    )
  })

  test("preserves correction-required todos", () => {
    expect(computeTodoStatus(null, "Correction Required")).toBe(
      "Correction Required",
    )
    expect(
      computeTodoStatus("2026-05-19T12:00:00.000Z", "Correction Required"),
    ).toBe("Correction Required")
    expect(
      computeTodoStatus("2026-05-21T12:00:00.000Z", "Correction Required"),
    ).toBe("Correction Required")
  })
})

describe("useOverdueRefresh", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const renderOverdueRefresh = async (dueTimes: string[]) => {
    vi.useFakeTimers()
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const dom = new JSDOM('<div id="root"></div>')
    const container = dom.window.document.getElementById("root")
    if (!container) throw new Error("Missing test root")

    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const originalHTMLElement = globalThis.HTMLElement
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    const cleanup = () => {
      restoreGlobal("window", originalWindow)
      restoreGlobal("document", originalDocument)
      restoreGlobal("HTMLElement", originalHTMLElement)
      restoreGlobal("IS_REACT_ACT_ENVIRONMENT", originalActEnvironment)
    }

    function TestComponent({ dueTimes }: { dueTimes: string[] }) {
      useOverdueRefresh(dueTimes)
      return null
    }

    stubGlobal("window", dom.window)
    stubGlobal("document", dom.window.document)
    stubGlobal("HTMLElement", dom.window.HTMLElement)
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)

    let root: ReturnType<typeof createRoot> | undefined
    try {
      root = createRoot(container)
      await act(async () => {
        root?.render(createElement(TestComponent, { dueTimes }))
      })
    } catch (error) {
      if (root) {
        await act(async () => {
          root?.unmount()
        })
      }
      cleanup()
      throw error
    }

    return {
      clearTimeoutSpy,
      rerender: (nextDueTimes: string[]) =>
        act(async () => {
          root.render(createElement(TestComponent, { dueTimes: nextDueTimes }))
        }),
      cleanup,
      unmount: () =>
        act(async () => {
          root?.unmount()
        }),
    }
  }

  test("does not reset timer for fresh arrays with the same due-time contents", async () => {
    const harness = await renderOverdueRefresh(["2026-05-20T13:00:00.000Z"])

    try {
      await harness.rerender(["2026-05-20T13:00:00.000Z"])

      expect(harness.clearTimeoutSpy).not.toHaveBeenCalled()

      await harness.unmount()
    } finally {
      harness.cleanup()
    }
  })

  test("resets timer when due-time contents change", async () => {
    const harness = await renderOverdueRefresh(["2026-05-20T13:00:00.000Z"])

    try {
      await harness.rerender(["2026-05-20T14:00:00.000Z"])

      // Effect cleanup must clear the previous timeout when due-time contents
      // change. Do not assert an exact call count: React act / concurrent
      // scheduling can invoke clearTimeout more than once for the same reset.
      expect(harness.clearTimeoutSpy).toHaveBeenCalled()

      await harness.unmount()
    } finally {
      harness.cleanup()
    }
  })
})
