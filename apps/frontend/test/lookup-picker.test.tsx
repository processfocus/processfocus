import { Schema } from "effect"
import { JSDOM } from "jsdom"
import { act } from "react"
import { LookupProvider, type LookupService } from "@pf/form/lookup-context"
import { LookupField } from "@pf/form-schema"
import { expect, setDefaultTimeout, test } from "bun:test"

// This isolated DOM journey exercises multiple real 300ms debounce cycles.
// Allow headroom for rendering and module initialization on shared CI runners.
setDefaultTimeout(15_000)

test("reopening a lookup refreshes choices while preserving the selected label", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  )
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
  const { EffectSchemaForm } = await import("@pf/form/effect-schema-form")
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  const choices = [
    { value: "1", label: "Alpha" },
    { value: "2", label: "Beta" },
    ...Array.from({ length: 298 }, (_, index) => ({
      value: String(index + 3),
      label: `Child ${index + 3}`,
    })),
  ]
  let currentChoices = choices.slice(1)
  let requests = 0
  const service: LookupService = {
    fetchSuggestions: async (_stepPath, _field, filter, limit) => {
      requests++
      return currentChoices
        .filter((item) => `${item.label} ${item.value}`.includes(filter))
        .slice(0, limit)
    },
    fetchDependentSuggestions: async () => [],
    fetchCalendarSlots: async () => [],
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
  const click = (selector: string) =>
    act(async () => {
      const target = document.querySelector(selector)
      if (!(target instanceof dom.window.HTMLElement))
        throw new Error(`Missing ${selector}`)
      target.click()
    })
  const choose = (label: string) =>
    act(async () => {
      const option = [...document.querySelectorAll('[role="option"]')].find(
        (item) => item.textContent === label,
      )
      if (!(option instanceof dom.window.HTMLElement))
        throw new Error(`Missing ${label}`)
      option.click()
    })
  try {
    await act(async () =>
      root.render(
        <LookupProvider value={service}>
          <EffectSchemaForm
            {...{
              draftId: "lookup-freshness",
              stepPath: "/fixture/start",
              schema: Schema.Struct({
                choice: LookupField({ label: "Choice" }),
              }),
              defaultValues: { choice: "21" },
              onSubmit: async () => undefined,
              children: () => null,
            }}
          />
        </LookupProvider>,
      ),
    )
    // A restored value can leave the first page when another child becomes eligible.
    await settle()
    // The form's delayed initial focus starts an editable-input search.
    await settle()
    await act(async () => {
      document.querySelector('input[role="combobox"]')!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      )
    })
    const selectionLabel = () =>
      document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value
    expect(selectionLabel()).toBe("Child 21")
    currentChoices = choices
    await click('input[role="combobox"]')
    expect(selectionLabel()).toBe("Child 21")
    await settle()
    expect(
      document.querySelector('[role="listbox"]')?.textContent,
    ).not.toContain("Child 21")
    await act(async () => {
      document.querySelector('input[role="combobox"]')!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      )
    })
    expect(selectionLabel()).toBe("Child 21")
    await click('input[role="combobox"]')
    await settle()
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
      "Alpha",
    )
    await choose("Alpha")
    currentChoices = choices.slice(1)
    const beforeReopen = requests
    await click('input[role="combobox"]')
    expect(
      document.querySelector('[role="listbox"]')?.textContent,
    ).not.toContain("Alpha")
    await settle()
    expect(requests).toBe(beforeReopen + 1)
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
      "Beta",
    )
    expect(
      document.querySelector('[role="listbox"]')?.textContent,
    ).not.toContain("Alpha")
    // An eligible selection beyond the initial page must keep its readable name.
    await act(async () => {
      const input = document.querySelector('input[role="combobox"]')!
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!
      setter.call(input, "300")
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
    await settle()
    await choose("Child 300")
    expect(selectionLabel()).toBe("Child 300")
    await click('input[role="combobox"]')
    expect(selectionLabel()).toBe("Child 300")
    expect(document.querySelector('input[role="combobox"]')).toHaveProperty(
      "value",
      "Child 300",
    )
    await settle()
    expect(
      document.querySelector('[role="listbox"]')?.textContent,
    ).not.toContain("Child 300")
    await act(async () => {
      document.querySelector('input[role="combobox"]')!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      )
    })
    expect(selectionLabel()).toBe("Child 300")
    // A later selection and deselection must not display the remembered child.
    await click('input[role="combobox"]')
    await settle()
    await choose("Beta")
    expect(selectionLabel()).toBe("Beta")
    await click('input[role="combobox"]')
    await settle()
    await choose("Beta")
    expect(selectionLabel()).toBe("Beta")
    await click('button[aria-label="Clear Choice"]')
    expect(selectionLabel()).toBe("")
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
