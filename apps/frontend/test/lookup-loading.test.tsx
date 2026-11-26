import { Schema } from "effect"
import { JSDOM } from "jsdom"
import { act } from "react"
import type { Root } from "react-dom/client"
import {
  LookupProvider,
  type LookupService,
  type LookupSuggestion,
} from "@pf/form/lookup-context"
import {
  BooleanField,
  LookupField,
  SuggestionField,
  TextField,
} from "@pf/form-schema"
import { afterEach, beforeEach, expect, jest, test } from "bun:test"

let dom: JSDOM
let root: Root
let restoreGlobals: () => void

beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )
  Object.assign(globalThis, globals)
  restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  const { createRoot } = await import("react-dom/client")
  const container = document.getElementById("root")
  if (!container) throw new Error("Missing root")
  root = createRoot(container)
  jest.useFakeTimers()
})

afterEach(async () => {
  await act(async () => root.unmount())
  jest.useRealTimers()
  dom.window.close()
  restoreGlobals()
})

function input(selector = 'input[role="combobox"]') {
  const target = document.querySelector(selector)
  if (!(target instanceof dom.window.HTMLInputElement))
    throw new Error(`Missing ${selector}`)
  return target
}

async function type(value: string, selector?: string) {
  await act(async () => {
    const target = input(selector)
    target.focus()
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set
    if (!setter) throw new Error("Missing input setter")
    setter.call(target, value)
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
}

const advance = async (ms = 300) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}
const pending = () => {
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "Loading results…",
  )
  expect(document.body.textContent).not.toContain("No results found.")
  expect(document.body.textContent).not.toContain("No suggestions found.")
  expect(
    [...document.querySelectorAll('[role="listbox"] [role="alert"]')]
      .map((node) => node.textContent)
      .join(""),
  ).toBe("")
  expect(document.querySelector('[role="option"]')).toBeNull()
}

for (const dependent of [false, true]) {
  for (const freeText of [false, true]) {
    test(`${dependent ? "dependent" : "independent"} ${freeText ? "suggestion" : "select"} lookup settles only the current search`, async () => {
      const requests: Array<{
        filter: unknown
        parent: unknown
        resolve: (items: LookupSuggestion[]) => void
        reject: (error: Error) => void
      }> = []
      const fetch = (filter: unknown, parent?: unknown) =>
        new Promise<LookupSuggestion[]>((resolve, reject) => {
          requests.push({ filter, parent, resolve, reject })
        })
      const service: LookupService = {
        fetchSuggestions: (_step, _field, filter) => fetch(filter),
        fetchDependentSuggestions: (_query, variables) => {
          const data = variables["input"]
          if (
            typeof data !== "object" ||
            data === null ||
            !("filter" in data) ||
            !("parent" in data)
          )
            throw new Error("Missing lookup input")
          return fetch(data.filter, data.parent)
        },
        fetchCalendarSlots: async () => [],
      }
      const request = (index = requests.length - 1) => {
        const result = requests[index]
        if (!result) throw new Error(`Missing request ${index}`)
        return result
      }
      const submissions: Record<string, unknown>[] = []
      const { EffectSchemaForm } = await import("@pf/form/effect-schema-form")
      await act(async () =>
        root.render(
          <LookupProvider value={service}>
            <EffectSchemaForm
              {...{
                draftId: "lookup-pending",
                stepPath: "/fixture/start",
                schema: Schema.Struct({
                  parent: TextField({ label: "Parent" }),
                  choice: freeText
                    ? SuggestionField({ label: "Choice" })
                    : LookupField({ label: "Choice" }),
                }),
                requestData: dependent
                  ? {
                      inaccessible: [],
                      presentation: {},
                      originalValues: {},
                      lookups: {
                        choice: {
                          dependencies: ["parent"],
                          queryName: "lookupChoice",
                        },
                      },
                    }
                  : undefined,
                defaultValues: { parent: "A", choice: "" },
                onSubmit: async (values) => {
                  submissions.push(values)
                },
                children: () => null,
              }}
            />
          </LookupProvider>,
        ),
      )
      await advance()
      expect(requests).toHaveLength(1)
      await act(async () => {
        input().focus()
      })
      pending()
      // Initial response cannot settle a newer search accepted while opening.
      await act(async () =>
        request(0).resolve([{ value: "old", label: "Old" }]),
      )
      pending()
      await advance()
      await act(async () => request().resolve([]))
      if (!freeText)
        expect(document.body.textContent).toContain("No results found.")
      await type("missing")
      const enterWithoutSelection = async () => {
        const event = new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
        await act(async () => {
          input().dispatchEvent(event)
        })
        // Free text retains native form submission; a lookup still needs a choice.
        expect(event.defaultPrevented).toBe(!freeText)
        expect(input().getAttribute("aria-expanded")).toBe("true")
      }
      await enterWithoutSelection()
      await advance()
      await act(async () => request().resolve([]))
      expect(document.body.textContent).toContain(
        freeText ? "No suggestions found." : "No results found.",
      )
      await enterWithoutSelection()
      const before = requests.length
      await type("Al")
      pending()
      await advance(299)
      expect(requests).toHaveLength(before)
      pending()
      await type("Alpha")
      await advance(299)
      expect(requests).toHaveLength(before)
      await advance(1)
      expect(request().filter).toBe("Alpha")
      pending()
      await act(async () =>
        request().resolve([{ value: "alpha", label: "Alpha" }]),
      )
      expect(document.querySelector('[role="option"]')?.textContent).toContain(
        "Alpha",
      )
      await type("older")
      await advance()
      const older = request()
      await type("")
      pending()
      await act(async () => older.resolve([{ value: "old", label: "Old" }]))
      pending()
      await advance()
      expect(request().filter).toBe("")
      await act(async () =>
        request().resolve([{ value: "alpha", label: "Alpha" }]),
      )
      expect(document.querySelector('[role="option"]')?.textContent).toContain(
        "Alpha",
      )
      await type("failure")
      await advance()
      await act(async () => request().reject(new Error("Network unavailable")))
      expect(document.body.textContent).toContain("Failed to load suggestions.")
      expect(document.body.textContent).not.toContain("No results found.")
      await enterWithoutSelection()
      await type("recovery")
      pending()
      await advance()
      const staleFailure = request()
      await type("latest")
      await advance()
      await act(async () =>
        request().resolve([{ value: "latest", label: "Latest" }]),
      )
      await act(async () => staleFailure.reject(new Error("Stale failure")))
      expect(document.querySelector('[role="option"]')?.textContent).toContain(
        "Latest",
      )
      expect(
        [...document.querySelectorAll('[role="alert"]')]
          .map((node) => node.textContent)
          .join(""),
      ).toBe("")

      if (dependent) {
        await type("in-flight")
        await advance()
        const oldDependency = request()
        await type("B", 'input[name="parent"]')
        expect(request().filter).toBe("")
        await act(async () => input().focus())
        await advance()
        pending()
        expect(request().parent).toBe("B")
        await act(async () =>
          oldDependency.resolve([
            { value: "wrong", label: "Wrong dependency" },
          ]),
        )
        pending()
        await act(async () =>
          request().resolve([{ value: "b", label: "B result" }]),
        )
        expect(
          document.querySelector('[role="option"]')?.textContent,
        ).toContain("B result")
        await type("queued")
        const count = requests.length
        await type("", 'input[name="parent"]')
        await advance()
        expect(requests).toHaveLength(count)
        const control = input()
        expect(control).toHaveProperty("disabled", true)
        expect(document.querySelector('[role="listbox"]')).toBeNull()
        if (!freeText)
          expect(input().getAttribute("aria-expanded")).toBe("false")
        await type("C", 'input[name="parent"]')
        expect(request().parent).toBe("C")
        if (!freeText) {
          // Restoring dependencies must not reopen a blank input over the old filter.
          const dependencyReload = request()
          expect(document.querySelector('[role="listbox"]')).toBeNull()
          expect(control?.getAttribute("aria-expanded")).toBe("false")
          await act(async () => {
            input().focus()
          })
          expect(input().value).toBe("")
          pending()
          await act(async () =>
            dependencyReload.resolve([
              { value: "queued", label: "Previous search result" },
            ]),
          )
          pending()
          await advance()
          expect(request().filter).toBe("")
          expect(request().parent).toBe("C")
          await act(async () =>
            request().resolve([{ value: "current", label: "Current choices" }]),
          )
          expect(
            document.querySelector('[role="option"]')?.textContent,
          ).toContain("Current choices")
          expect(document.body.textContent).not.toContain(
            "Previous search result",
          )
        }
      }
      if (freeText) {
        await type("A custom choice")
        await act(async () => {
          document.querySelector("form")?.dispatchEvent(
            new dom.window.Event("submit", {
              bubbles: true,
              cancelable: true,
            }),
          )
        })
        expect(submissions).toEqual([
          { parent: dependent ? "C" : "A", choice: "A custom choice" },
        ])
      }
    })
  }
}

test("selection prefills discard late responses, retain edits, block failed loads and reload on reopen", async () => {
  const requests: Array<{
    value: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }> = []
  const submissions: Record<string, unknown>[] = []
  const service: LookupService = {
    fetchSuggestions: async () => [],
    fetchDependentSuggestions: async () => [],
    fetchCalendarSlots: async () => [],
    fetchPrefill: (_query, value) =>
      new Promise((resolve, reject) =>
        requests.push({ value, resolve, reject }),
      ),
  }
  const { EffectSchemaForm } = await import("@pf/form/effect-schema-form")
  const render = () =>
    root.render(
      <LookupProvider value={service}>
        <EffectSchemaForm
          {...{
            draftId: "prefill-lifecycle",
            stepPath: "/fixture/start",
            schema: Schema.Struct({
              parent: TextField({ label: "Parent" }),
              checked: BooleanField({ label: "Preference" }),
              date: TextField({ label: "Context date" }),
            }),
            requestData: {
              inaccessible: [],
              presentation: {},
              originalValues: {},
              lookups: {},
              prefill: {
                dependency: "parent",
                fields: ["checked", "date"],
                concealed: ["date"],
                queryName: "prefillFixture",
              },
            },
            defaultValues: { parent: "", checked: false, date: "" },
            onSubmit: async (value) => {
              submissions.push(value)
              return undefined
            },
            children: () => <button type="submit">Submit</button>,
          }}
        />
      </LookupProvider>,
    )
  const click = async (selector: string) =>
    act(async () => {
      const node = document.querySelector(selector)
      if (!(node instanceof dom.window.HTMLElement))
        throw new Error(`Missing ${selector}`)
      node.click()
    })
  const checked = () =>
    String(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked,
    )
  await act(async () => render())
  expect(document.body.textContent).not.toContain("Context date")
  await type("a", 'input[name="parent"]')
  await type("b", 'input[name="parent"]')
  expect(requests.map((r) => r.value)).toEqual(["a", "b"])
  await act(async () =>
    requests[1]!.resolve({ checked: false, date: "2026-09-24" }),
  )
  await act(async () =>
    requests[0]!.resolve({ checked: true, date: "2026-09-23" }),
  )
  expect(checked()).toBe("false")
  await click('input[type="checkbox"]')
  expect(checked()).toBe("true")
  await act(async () => render())
  expect(requests).toHaveLength(2)
  expect(checked()).toBe("true")
  await type("", 'input[name="parent"]')
  expect(checked()).toBe("false")
  await type("c", 'input[name="parent"]')
  await act(async () => requests[2]!.reject(new Error("unavailable")))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load",
  )
  await click('button[type="submit"]')
  expect(submissions).toEqual([])
  await act(async () => {
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )
    retry!.click()
  })
  await act(async () =>
    requests[3]!.resolve({ checked: true, date: "2026-09-24" }),
  )
  await click('button[type="submit"]')
  expect(submissions).toEqual([
    { parent: "c", checked: true, date: "2026-09-24" },
  ])
  await act(async () => root.render(null))
  await act(async () => render())
  await type("c", 'input[name="parent"]')
  expect(requests).toHaveLength(5)
})
