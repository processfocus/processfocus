import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  assignedAtRefreshDelay,
  computeTodoStatus,
  formatAssignedAtExact,
  formatAssignedAtLabel,
  useOverdueRefresh,
} from "../lib/todo-utils"

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

describe("formatAssignedAtLabel", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("formats recent assignments as just now", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-20T11:59:30.000Z")).toBe(
      "Assigned just now",
    )
  })

  test("formats same-day assignments by elapsed hours", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-20T10:00:00.000Z")).toBe(
      "Assigned 2 hours ago",
    )
  })

  test("formats singular elapsed hours", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-20T11:00:00.000Z")).toBe(
      "Assigned 1 hour ago",
    )
  })

  test("formats same-day assignments by elapsed minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-20T11:32:00.000Z")).toBe(
      "Assigned 28 minutes ago",
    )
  })

  test("formats singular elapsed minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-20T11:59:00.000Z")).toBe(
      "Assigned 1 minute ago",
    )
  })

  test("formats yesterday explicitly", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-19T12:00:00.000Z")).toBe(
      "Assigned yesterday",
    )
  })

  test("formats assignments from earlier this week by elapsed days", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-16T12:00:00.000Z")).toBe(
      "Assigned 4 days ago",
    )
  })

  test("formats older assignments as a date", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(formatAssignedAtLabel("2026-05-01T12:00:00.000Z")).toBe(
      "Assigned May 1, 2026",
    )
  })

  test("handles invalid assigned timestamps", () => {
    expect(formatAssignedAtLabel("not-a-date")).toBe("Assigned at unknown time")
  })
})

describe("assignedAtRefreshDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("refreshes recent assignments when the minute label can change", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(assignedAtRefreshDelay("2026-05-20T11:59:30.000Z")).toBe(31_000)
  })

  test("schedules refresh to next hour boundary", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(assignedAtRefreshDelay("2026-05-20T09:59:30.000Z")).toBe(3_571_000)
  })

  test("refreshes day labels at day boundaries", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(assignedAtRefreshDelay("2026-05-19T12:00:00.000Z")).toBe(86_401_000)
  })

  test("stops refreshing when assigned date labels no longer change", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)

    expect(assignedAtRefreshDelay("2026-05-01T12:00:00.000Z")).toBeNull()
  })

  test("does not refresh invalid assigned timestamps", () => {
    expect(assignedAtRefreshDelay("not-a-date")).toBeNull()
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

describe("formatAssignedAtExact", () => {
  test("formats exact assigned timestamps", () => {
    expect(formatAssignedAtExact("2026-05-20T10:15:00")).toMatch(
      /^Assigned May 20, 2026,/,
    )
  })

  test("handles invalid assigned timestamps", () => {
    expect(formatAssignedAtExact("not-a-date")).toBe("Assigned at unknown time")
  })
})
