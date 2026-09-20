import { JSDOM } from "jsdom"
import { act } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { parseClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import EmbedClient from "../app/embed/[...startStepPath]/embed-client"
import type { EmbedManifestEntry } from "../lib/embed-manifest"

const formDefinition = parseClientFormDefinition({
  components: {
    choice: {
      _tag: "text",
      field: "choice",
      label: "Choice",
      readonly: true,
    },
    details: { _tag: "text", field: "details", label: "Details" },
  },
  rules: [
    {
      condition: {
        _tag: "equals",
        left: { _tag: "field", path: ["choice"] },
        right: { _tag: "literal", value: "disable" },
      },
      effects: [{ target: ["details"], state: { disabled: true } }],
    },
  ],
})
const jsonSchema = {
  type: "object",
  properties: {
    choice: { type: "string" },
    details: { type: "string" },
  },
}

const entry: EmbedManifestEntry = {
  stepPath: "/enrolment/Submit",
  processName: "Enrolment",
  processPath: "/enrolment",
  mutationName: "startEnrolment",
  inputTypeName: "EnrolmentSubmit",
  totalFields: 2,
  formDefinition,
  defaultValues: { choice: "disable", details: "" },
  jsonSchema,
  sites: ["https://school.example.com"],
  thankYou: "Thanks",
}

describe("embedded form client", () => {
  test("renders the structured definition and applies its rules", () => {
    const markup = renderToStaticMarkup(<EmbedClient entry={entry} />)

    expect(markup).toContain('name="choice"')
    expect(markup).toContain('name="details"')
    expect(markup).toMatch(
      /<input(?=[^>]*name="details")(?=[^>]*readOnly="")[^>]*>/,
    )
  })

  test("submits the structured definition through the iframe endpoint", async () => {
    const cleanupDom = installDom()
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
      await act(async () => root.render(<EmbedClient entry={entry} />))

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
          values: { choice: "disable", details: "" },
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
})

const installDom = (): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://dashboard.example.com/embed/enrolment/Submit",
  })
  const previousGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    MutationObserver: globalThis.MutationObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
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
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    MutationObserver: dom.window.MutationObserver,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
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
