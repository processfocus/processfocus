import { JSDOM } from "jsdom"
import { StrictMode, act } from "react"
import { createRoot } from "react-dom/client"
import { SessionReissue } from "../components/session-reissue"
import { expect, mock, test } from "bun:test"

test("reissuance parses one response in StrictMode and never reloads a rejected session", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  const reload = mock(() => {})
  Reflect.set(globalThis, "window", { location: { reload } })
  Reflect.set(globalThis, "document", dom.window.document)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    for (const success of [true, false]) {
      const refresh = mock(async () => Response.json({ success }))
      Reflect.set(globalThis, "fetch", refresh)
      reload.mockClear()
      await act(async () => {
        root.render(
          <StrictMode>
            <SessionReissue key={String(success)} />
          </StrictMode>,
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledTimes(success ? 1 : 0)
      if (!success)
        expect(container.querySelector("a")?.getAttribute("href")).toBe(
          "/login",
        )
    }
  } finally {
    await act(async () => root.unmount())
    Reflect.set(globalThis, "window", previousWindow)
    Reflect.set(globalThis, "document", previousDocument)
    Reflect.set(globalThis, "fetch", previousFetch)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
    dom.window.close()
  }
})
