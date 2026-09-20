import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"
import StatsError from "../app/(protected)/stats/[...statsPath]/error"
import PublicFormError from "../app/public/form/[token]/error"

test.each([StatsError, PublicFormError])(
  "%s retries loading repeatedly without submitting an enclosing form",
  async (ErrorComponent) => {
    const dom = new JSDOM('<div id="root"></div>')
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    const container = dom.window.document.getElementById("root")
    if (!container) throw new Error("Missing root")
    const root = createRoot(container)
    const retry = vi.fn()
    const submit = vi.fn()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await act(async () => {
        root.render(
          createElement(
            "form",
            { onSubmit: submit },
            createElement(ErrorComponent, {
              error: new Error("load failed"),
              retry,
            }),
          ),
        )
      })
      const button = container.querySelector("button")
      if (!button) throw new Error("Missing retry button")
      expect(button.textContent).toBe("Try again")
      expect(button.type).toBe("button")
      await act(async () => button.click())
      await act(async () => button.click())
      expect(retry).toHaveBeenCalledTimes(2)
      expect(submit).not.toHaveBeenCalled()
      expect(button.disabled).toBe(false)
    } finally {
      await act(async () => root.unmount())
      log.mockRestore()
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  },
)
