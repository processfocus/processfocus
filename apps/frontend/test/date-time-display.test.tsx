import { JSDOM } from "jsdom"
import { type ReactNode, act } from "react"
import { type Root, createRoot, hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { DateTimeDisplay, DateTimeDisplayProvider } from "@pf/shadcn-components"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

const instant = "2026-01-02T03:04:05.000Z"
const reference = Date.parse("2026-01-02T03:09:05.000Z")
const tree = (children: ReactNode) => (
  <DateTimeDisplayProvider initialNow={reference}>
    {children}
  </DateTimeDisplayProvider>
)

describe("read-only date/time display", () => {
  let dom: JSDOM
  let container: HTMLDivElement
  let root: Root | undefined
  const globals = new Map<string, PropertyDescriptor | undefined>()
  const originalZone = process.env["TZ"]
  let clock: ReturnType<typeof spyOn<typeof Date, "now">>

  beforeEach(() => {
    process.env["TZ"] = "America/New_York"
    clock = spyOn(Date, "now").mockReturnValue(reference)
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      pretendToBeVisual: true,
    })
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      })
    }
    container = document.createElement("div")
    document.body.append(container)
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    clock.mockRestore()
    dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    if (originalZone === undefined) delete process.env["TZ"]
    else process.env["TZ"] = originalZone
  })
  async function mount(children: ReactNode) {
    root = createRoot(container)
    await act(async () => root?.render(tree(children)))
  }
  function button(index = 0) {
    const result = container.querySelectorAll("button")[index]
    if (!result) throw new Error("Expected timestamp button")
    return result
  }
  async function click(index = 0) {
    await act(async () => button(index).click())
  }

  test("cycles independent instances and isolates row activation", async () => {
    let activated = 0
    await mount(
      <table>
        <tbody>
          <tr
            tabIndex={0}
            onClick={() => activated++}
            onKeyDown={() => activated++}
          >
            <td>
              <DateTimeDisplay kind="timestamp" value={instant} />
              <DateTimeDisplay kind="timestamp" value={instant} />
            </td>
          </tr>
        </tbody>
      </table>,
    )
    expect(button().textContent).toBe("5 minutes ago")
    expect(button().querySelector("time")?.dateTime).toBe(instant)
    await click()
    expect(button().getAttribute("aria-label")).toContain(
      "Browser-local time. Show UTC",
    )
    expect(button().textContent).toContain("Jan 1, 2026, 10:04 PM EST")
    expect(button(1).textContent).toBe("5 minutes ago")
    await click()
    expect(button().textContent).toContain("Jan 2, 2026, 3:04 AM UTC")
    await click()
    expect(button().textContent).toBe("5 minutes ago")
    button().dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    )
    expect(activated).toBe(0)
  })

  test("event-local starts retain the full cycle, with seconds and duplicate zone aliases skipped", async () => {
    await mount(
      <>
        <DateTimeDisplay
          kind="timestamp"
          value={instant}
          eventTimeZone="Pacific/Auckland"
          initialMode="event-local"
          seconds
        />
        <DateTimeDisplay
          kind="timestamp"
          value={instant}
          eventTimeZone="US/Eastern"
        />
        <DateTimeDisplay
          kind="timestamp"
          value={instant}
          eventTimeZone="Etc/UTC"
        />
      </>,
    )
    expect(button().textContent).toContain("Jan 2, 2026, 4:04:05 PM")
    expect(button().getAttribute("aria-label")).toContain(
      "Event-local time. Show UTC",
    )
    await click()
    expect(button().textContent).toContain("3:04:05 AM UTC")
    await click()
    expect(button().textContent).toBe("5 minutes ago")
    await click()
    expect(button().getAttribute("aria-label")).toContain(
      "Show Event-local time",
    )
    await click()
    expect(button().textContent).toContain("4:04:05 PM")
    await click(1)
    expect(button(1).getAttribute("aria-label")).toContain("Show UTC")
    await click(2)
    await click(2)
    expect(button(2).getAttribute("aria-label")).toContain("Show Relative time")
  })

  test.each(["browser-local", "utc"] as const)(
    "%s initial override still reaches every ordinary mode",
    async (initialMode) => {
      await mount(
        <DateTimeDisplay
          kind="timestamp"
          value={instant}
          initialMode={initialMode}
        />,
      )
      const labels = []
      for (let index = 0; index < 3; index++) {
        labels.push(button().getAttribute("aria-label") ?? "")
        await click()
      }
      expect(
        labels.some((label) => label.includes("Browser-local time. Show UTC")),
      ).toBe(true)
      expect(
        labels.some((label) => label.includes("UTC. Show Relative time")),
      ).toBe(true)
      expect(
        labels.some((label) =>
          label.includes("Relative time. Show Browser-local time"),
        ),
      ).toBe(true)
    },
  )

  test("calendar dates stay on their calendar day across viewer zones and reject impossible dates", async () => {
    const error = spyOn(globalThis, "reportError").mockImplementation(() => {})
    try {
      for (const zone of ["America/Los_Angeles", "Pacific/Auckland"]) {
        process.env["TZ"] = zone
        await mount(
          <>
            <DateTimeDisplay kind="calendar-date" value="2026-01-02" />
            <DateTimeDisplay kind="calendar-date" value="2026-02-30" />
          </>,
        )
        expect(container.querySelector("time")?.textContent).toBe("Jan 2, 2026")
        expect(container.querySelector("time")?.dateTime).toBe("2026-01-02")
        expect(container.querySelector("button")).toBeNull()
        expect(container.textContent).toContain("Invalid date")
        await act(async () => root?.unmount())
        root = undefined
      }
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  test("SSR and hydration share relative reference and labelled UTC fallback before browser discovery", async () => {
    const children = (
      <>
        <DateTimeDisplay kind="timestamp" value={instant} />
        <DateTimeDisplay
          kind="timestamp"
          value={instant}
          initialMode="browser-local"
          seconds
        />
        <DateTimeDisplay kind="calendar-date" value="2026-01-02" />
      </>
    )
    container.innerHTML = renderToString(tree(children))
    expect(button().textContent).toBe("5 minutes ago")
    expect(button(1).textContent).toContain("Jan 2, 2026, 3:04:05 AM UTC")
    expect(button(1).getAttribute("aria-label")).toContain(
      "UTC (browser-local time pending)",
    )
    process.env["TZ"] = "Pacific/Auckland"
    clock.mockReturnValue(reference + 120_000)
    const errors: unknown[] = []
    await act(async () => {
      root = hydrateRoot(container, tree(children), {
        onRecoverableError: (error) => errors.push(error),
      })
    })
    expect(errors).toEqual([])
    expect(button().textContent).toBe("7 minutes ago")
    expect(button(1).textContent).toContain("Jan 2, 2026, 4:04:05 PM")
    expect(container.querySelectorAll("time")[2]?.textContent).toBe(
      "Jan 2, 2026",
    )
  })

  test("relative wording includes future direction, refreshes on the timer and catches up on visibility", async () => {
    await mount(
      <DateTimeDisplay kind="timestamp" value={reference + 120_000} />,
    )
    expect(button().textContent).toBe("in 2 minutes")
    clock.mockReturnValue(reference + 60_000)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_100))
    })
    expect(button().textContent).toBe("in 1 minute")
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })
    clock.mockReturnValue(reference + 180_000)
    await act(async () =>
      document.dispatchEvent(new dom.window.Event("visibilitychange")),
    )
    expect(button().textContent).toBe("in 1 minute")
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    await act(async () =>
      document.dispatchEvent(new dom.window.Event("visibilitychange")),
    )
    expect(button().textContent).toBe("1 minute ago")
  }, 15_000)

  test("invalid instants and zones report sanitized diagnostics without crashing", async () => {
    const error = spyOn(globalThis, "reportError").mockImplementation(() => {})
    try {
      await mount(
        <>
          <DateTimeDisplay kind="timestamp" value="private invalid input" />
          <DateTimeDisplay
            kind="timestamp"
            value={instant}
            eventTimeZone="not-a-zone"
          />
          <DateTimeDisplay kind="timestamp" value={new Date(Number.NaN)} />
          <DateTimeDisplay kind="timestamp" value="2026-02-30T12:00:00Z" />
          <DateTimeDisplay kind="timestamp" value="2026-01-02T03:04:05" />
        </>,
      )
      expect(container.textContent).toBe("Invalid date".repeat(5))
      expect(error).toHaveBeenCalledTimes(5)
      expect(error.mock.calls.flat().map(String).join()).not.toContain(
        "private invalid input",
      )
    } finally {
      error.mockRestore()
    }
  })
})
