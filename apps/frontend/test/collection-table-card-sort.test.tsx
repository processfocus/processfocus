import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { CollectionTableHeaderRow } from "../components/collections/collection-table-header-row"

describe("CollectionTableCard sortable headers", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
    vi.restoreAllMocks()
  })

  test("renders sortable headers as accessible controls with reserved icon space", async () => {
    const onSortChange = vi.fn()

    await act(async () => {
      root.render(
        <table>
          <thead>
            <CollectionTableHeaderRow
              columns={[
                {
                  key: "name",
                  label: "Name",
                  sortable: true,
                  sortDirection: null,
                  render: (item: { readonly name: string }) => item.name,
                },
              ]}
              onSortChange={onSortChange}
            />
          </thead>
        </table>,
      )
    })

    const header = container.querySelector("th")
    const button = container.querySelector("th button")
    const iconSlot = container.querySelector("th button span:nth-child(2)")

    expect(header?.getAttribute("aria-sort")).toBe("none")
    expect(button?.textContent).toContain("Name")
    expect(button?.textContent).toContain("Not sorted")
    expect(iconSlot).not.toBeNull()

    await act(async () => {
      button?.click()
    })

    expect(onSortChange).toHaveBeenCalledWith("name")
  })

  test("shows active ascending and descending sort state", async () => {
    await act(async () => {
      root.render(
        <table>
          <thead>
            <CollectionTableHeaderRow
              columns={[
                {
                  key: "name",
                  label: "Name",
                  sortable: true,
                  sortDirection: "asc",
                  render: (item: { readonly name: string }) => item.name,
                },
              ]}
              onSortChange={() => {}}
            />
          </thead>
        </table>,
      )
    })

    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "ascending",
    )
    expect(container.querySelector("th button")?.textContent).toContain(
      "Sorted ascending",
    )
    expect(container.querySelector("th svg")?.getAttribute("class")).toContain(
      "text-slate-900",
    )

    await act(async () => {
      root.render(
        <table>
          <thead>
            <CollectionTableHeaderRow
              columns={[
                {
                  key: "name",
                  label: "Name",
                  sortable: true,
                  sortDirection: "desc",
                  render: (item: { readonly name: string }) => item.name,
                },
              ]}
              onSortChange={() => {}}
            />
          </thead>
        </table>,
      )
    })

    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    )
    expect(container.querySelector("th button")?.textContent).toContain(
      "Sorted descending",
    )
  })

  test("renders non-sortable headers without clickable affordances", async () => {
    const onSortChange = vi.fn()

    await act(async () => {
      root.render(
        <table>
          <thead>
            <CollectionTableHeaderRow
              columns={[
                {
                  key: "status",
                  label: "Status",
                  sortable: false,
                  render: (item: { readonly status: string }) => item.status,
                },
              ]}
              onSortChange={onSortChange}
            />
          </thead>
        </table>,
      )
    })

    expect(container.querySelector("th")?.hasAttribute("aria-sort")).toBe(false)
    expect(container.querySelector("th button")).toBeNull()
    expect(container.querySelector("th")?.textContent).toBe("Status")
    expect(onSortChange).not.toHaveBeenCalled()
  })
})

const installDom = (url: string): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })

  const previousGlobals = {
    document: globalThis.document,
    history: globalThis.history,
    navigator: globalThis.navigator,
    window: globalThis.window,
  }
  const previousActEnvironment = {
    hasValue: "IS_REACT_ACT_ENVIRONMENT" in globalThis,
    value: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    history: dom.window.history,
    navigator: dom.window.navigator,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, {
      document: previousGlobals.document,
      history: previousGlobals.history,
      navigator: previousGlobals.navigator,
      window: previousGlobals.window,
    })
    if (previousActEnvironment.hasValue) {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment.value
    } else {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT
    }
  }
}
