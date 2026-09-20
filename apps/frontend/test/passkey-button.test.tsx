import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const startAuthentication = mock(() => Promise.resolve({ id: "credential" }))
const startRegistration = mock()

mock.module("@simplewebauthn/browser", () => ({
  startAuthentication,
  startRegistration,
  WebAuthnAbortService: { cancelCeremony: mock() },
}))

const { PasskeyButton } = await import("../app/login/passkey-button")
const originalGlobals = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  MouseEvent: globalThis.MouseEvent,
  window: globalThis.window,
}

describe("PasskeyButton", () => {
  let dom: JSDOM
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://console.example.com/login",
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
    startAuthentication.mockClear()
    startRegistration.mockClear()
  })

  test("signs in usernameless with an empty auth-options body", async () => {
    const responses = [
      Response.json({}),
      Response.json({ challengeId: "challenge", options: {} }),
      Response.json({}),
    ]
    const fetchMock = mock(() =>
      Promise.resolve(responses.shift() ?? Response.json({})),
    )
    globalThis.fetch = fetchMock as typeof fetch

    await act(async () => root.render(<PasskeyButton />))

    expect(container.querySelector('input[type="email"]')).toBeNull()

    const signIn = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Sign in with Passkey",
    )
    expect(signIn).toBeDefined()

    await act(async () => {
      signIn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/passkey/auth-options",
      expect.objectContaining({ body: "{}", method: "POST" }),
    )
    expect(startAuthentication).toHaveBeenCalledTimes(1)
    expect(container.querySelector('input[type="email"]')).toBeNull()
  })

  test("registration still prompts for email when Open Registration is enabled", async () => {
    await act(async () =>
      root.render(<PasskeyButton openRegistration={true} />),
    )

    const register = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Register a new Passkey",
    )
    await act(async () => {
      register?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector('input[type="email"]')).not.toBeNull()
    expect(container.textContent).toContain("Email for new passkey")
  })

  test.each([
    "/act-on-behalf",
    `/act-on-behalf?${new URLSearchParams({ ownerUserId: "external|owner+id&not=a-query" })}`,
  ])(
    "reauthentication performs a new passkey ceremony returning to %s",
    async (redirect) => {
      const responses = [
        Response.json({}),
        Response.json({ challengeId: "fresh", options: {} }),
        Response.json({}),
      ]
      const fetchMock = mock(() =>
        Promise.resolve(responses.shift() ?? Response.json({})),
      )
      globalThis.fetch = fetchMock as typeof fetch
      await act(async () =>
        root.render(
          <PasskeyButton purpose="reauthenticate" redirect={redirect} />,
        ),
      )
      expect(container.textContent).not.toContain("Registration Link")
      const button = container.querySelector("button")!
      expect(button.textContent).toBe("Authenticate again with Passkey")
      await act(async () => button.click())
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/auth/passkey/start",
        expect.objectContaining({
          body: JSON.stringify({ redirect, purpose: "reauthenticate" }),
        }),
      )
      expect(startAuthentication).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "/api/auth/passkey/auth-verify",
        expect.objectContaining({
          body: JSON.stringify({
            challengeId: "fresh",
            response: { id: "credential" },
          }),
        }),
      )
    },
  )

  test("hides self-registration in invite-only mode", async () => {
    await act(async () =>
      root.render(<PasskeyButton openRegistration={false} />),
    )

    const register = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Register a new Passkey",
    )
    expect(register).toBeUndefined()
    expect(container.textContent).toContain(
      "First-time users must use their Registration Link.",
    )
    expect(container.querySelector('input[type="email"]')).toBeNull()
  })
})

const setGlobal = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}
