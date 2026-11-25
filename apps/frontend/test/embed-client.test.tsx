import { Schema } from "effect"
import { JSDOM } from "jsdom"
import { act } from "react"
import { describe, expect, test, vi } from "vitest"
import { LookupField } from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"
import type { EmbedManifestEntry } from "../lib/embed-manifest"

vi.mock("@/lib/frontend-form-loaders", () => ({
  loadBrowserFormDefinition: () => definition,
}))
let definition: Promise<Schema.Top> = Promise.resolve(
  withFormRules(
    Schema.Struct({ choice: Schema.String, details: Schema.String }),
    () => ({ details: { disabled: true } }),
  ),
)
const data = {
  defaultValues: { choice: "disable", details: "Authoritative details" },
  pluginConfiguration: {},
  requestData: {
    presentation: {},
    originalValues: { details: "Authoritative details" },
    inaccessible: [],
  },
}

const entry: EmbedManifestEntry = {
  stepPath: "/enrolment/Submit",
  processName: "Enrolment",
  processPath: "/enrolment",
  mutationName: "startEnrolment",
  inputTypeName: "EnrolmentSubmit",
  totalFields: 2,
  formPath: "/enrolment/Submit",
  lookups: [],
  sites: ["https://school.example.com"],
  thankYou: "Thanks",
}

describe("embedded form client", () => {
  test("submits encoded values from the executable schema through the iframe endpoint", async () => {
    const cleanupDom = installDom()
    const { default: EmbedClient } = await import(
      "../app/embed/[...startStepPath]/embed-client"
    )
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    globalThis.fetch = fetchMock
    const container = document.createElement("div")
    document.body.appendChild(container)
    const { createRoot } = await import("react-dom/client")
    const root = createRoot(container)

    try {
      await act(async () =>
        root.render(<EmbedClient entry={entry} data={data} />),
      )

      const form = container.querySelector("form")
      if (!form) throw new Error("Expected the iframe form to render")

      await act(async () => {
        form.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(fetchMock).toHaveBeenCalledWith("/api/embed/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepPath: entry.stepPath,
          values: { choice: "disable", details: "Authoritative details" },
        }),
      })
      expect(container.textContent).toContain("Submitted")
      expect(container.textContent).toContain("Thanks")
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = originalFetch
      cleanupDom()
    }
  })

  test("resolves a restored choice and searches with truncation through the embed transport", async () => {
    const cleanupDom = installDom()
    const { default: EmbedClient } = await import(
      "../app/embed/[...startStepPath]/embed-client"
    )
    const previousDefinition = definition
    const originalFetch = globalThis.fetch
    definition = Promise.resolve(
      Schema.Struct({
        choice: LookupField({ label: "Choice", mode: "server" }),
      }),
    )
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Unknown),
      )(JSON.parse(String(init?.body)))
      requests.push(body)
      return Response.json({
        items: body["selectedValue"]
          ? [{ value: "saved", label: "Saved choice" }]
          : Array.from({ length: 21 }, (_, index) => ({
              value: `choice-${index}`,
              label: `Choice ${index}`,
            })),
      })
    })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const { createRoot } = await import("react-dom/client")
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <EmbedClient
            entry={entry}
            data={{ ...data, defaultValues: { choice: "saved" } }}
          />,
        ),
      )
      const input = container.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!
      expect(input.value).toBe("Saved choice")
      expect(requests.filter((request) => "selectedValue" in request)).toEqual([
        { stepPath: entry.stepPath, field: "choice", selectedValue: "saved" },
      ])
      await act(async () => {
        input.focus()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(document.body.textContent).toContain("More matches—keep typing")
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(20)
      expect(requests.filter((request) => "filter" in request)).toEqual([
        { stepPath: entry.stepPath, field: "choice", filter: "", limit: 21 },
      ])
      const option =
        document.querySelector<HTMLButtonElement>('[role="option"]')!
      await act(async () => option.click())
      expect(input.value).toBe("Choice 0")
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          )
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(requests.at(-1)).toEqual({
        stepPath: entry.stepPath,
        values: { choice: "choice-0" },
      })
      expect(container.textContent).toContain("Submitted")
    } finally {
      await act(async () => root.unmount())
      definition = previousDefinition
      globalThis.fetch = originalFetch
      cleanupDom()
    }
  })
})

const installDom = (): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example.com/embed/enrolment/Submit",
  })
  const previousGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    CustomEvent: globalThis.CustomEvent,
    document: globalThis.document,
    DocumentFragment: globalThis.DocumentFragment,
    Element: globalThis.Element,
    Event: globalThis.Event,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    MutationObserver: globalThis.MutationObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  }
  const previousActEnvironment = {
    hasValue: "IS_REACT_ACT_ENVIRONMENT" in globalThis,
    value: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined,
    }),
  })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener)
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener)
      },
    },
  })

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    cancelAnimationFrame: () => undefined,
    CustomEvent: dom.window.CustomEvent,
    document: dom.window.document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    MutationObserver: dom.window.MutationObserver,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    },
    window: dom.window,
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
