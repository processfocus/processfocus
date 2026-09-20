import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const startRegistration = mock()

mock.module("@simplewebauthn/browser", () => ({
  startAuthentication: mock(),
  startRegistration,
}))

const { RegisterPasskeyClient } = await import(
  "../app/register/passkey/register-passkey-client"
)

const originalGlobals = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  MouseEvent: globalThis.MouseEvent,
  window: globalThis.window,
}

const setGlobal = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  })
}

describe("RegisterPasskeyClient", () => {
  let dom: JSDOM
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://app.example.com/register/passkey#token=secret-token-value",
    })
    setGlobal("window", dom.window)
    setGlobal("document", dom.window.document)
    setGlobal("HTMLElement", dom.window.HTMLElement)
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    setGlobal("MouseEvent", dom.window.MouseEvent)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    setGlobal("window", originalGlobals.window)
    setGlobal("document", originalGlobals.document)
    setGlobal("HTMLElement", originalGlobals.HTMLElement)
    setGlobal(
      "IS_REACT_ACT_ENVIRONMENT",
      originalGlobals.IS_REACT_ACT_ENVIRONMENT,
    )
    setGlobal("MouseEvent", originalGlobals.MouseEvent)
    globalThis.fetch = originalGlobals.fetch
    startRegistration.mockClear()
  })

  test("scrubs the fragment and exchanges the token for a Registration Session", async () => {
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/auth/passkey/registration-session")) {
        return Promise.resolve(
          Response.json({
            email: "invitee@example.com",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        )
      }
      return Promise.resolve(
        Response.json({ error: "unexpected" }, { status: 500 }),
      )
    })
    globalThis.fetch = fetchMock as typeof fetch

    // Simulate layout scrub script stashing the token before React mounts.
    ;(
      dom.window as Window & { __PF_REGISTRATION_LINK_TOKEN?: string }
    ).__PF_REGISTRATION_LINK_TOKEN = "secret-token-value"
    dom.window.history.replaceState(null, "", "/register/passkey")

    await act(async () => {
      root.render(<RegisterPasskeyClient isSignedIn={false} />)
    })

    // Allow exchange effect to settle.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dom.window.location.hash).toBe("")
    expect(fetchMock).toHaveBeenCalled()
    const exchangeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/auth/passkey/registration-session"),
    )
    expect(exchangeCall).toBeDefined()
    const init = exchangeCall?.[1] as RequestInit
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      token: "secret-token-value",
    })

    expect(container.textContent).toContain("invitee@example.com")
    expect(container.textContent).not.toContain("secret-token-value")
  })

  test("shows sign-out guidance when already signed in without exchanging", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json({ error: "should-not-call" }, { status: 500 }),
      ),
    )
    globalThis.fetch = fetchMock as typeof fetch

    await act(async () => {
      root.render(<RegisterPasskeyClient isSignedIn={true} />)
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Sign out to continue")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
