import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { LoginFormContent } from "../app/login/login-form-content"
import { canOpenActOnBehalfMenu } from "../lib/auth/act-on-behalf-menu"

describe("LoginForm", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root
  const originalFetch = globalThis.fetch
  const originalFormData = globalThis.FormData

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com/login")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
    globalThis.fetch = originalFetch
    globalThis.FormData = originalFormData
  })

  test("uses generic access-denied copy without a dummy bypass user", async () => {
    window.history.pushState(null, "", "/login?error=not_authorized")

    await act(async () => {
      root.render(
        <LoginFormContent
          hasPasskey={false}
          oauthProviders={[]}
          searchParams={new URLSearchParams(window.location.search)}
        />,
      )
    })

    expect(container.textContent).toContain("Access Denied")
    expect(container.textContent).toContain(
      "You don't have permission to access this application.",
    )
    expect(container.textContent).not.toContain("PF_BYPASS_AUTH")
  })

  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "presentation=%s and listing=%s remain independent",
    async (secretLoginEnabled, canList) => {
      await act(async () => {
        root.render(
          <LoginFormContent
            hasPasskey
            oauthProviders={["google"]}
            secretLoginEnabled={secretLoginEnabled}
            searchParams={
              new URLSearchParams(
                "secretLoginEnabled=true&delegatedAccess=true",
              )
            }
          />,
        )
      })
      expect(container.querySelector("#login-secret") !== null).toBe(
        secretLoginEnabled,
      )
      expect(
        canOpenActOnBehalfMenu(
          canList ? { kind: "success" } : { kind: "denied" },
        ),
      ).toBe(canList)
      expect(container.textContent).toContain("Google")
      expect(container.textContent).toContain("Passkey")
    },
  )

  test.each([
    ["/to-dos/complete/example?tab=work", "/to-dos/complete/example?tab=work"],
    [
      "%2Fexecutions%2Fexample%3Ftab%3Dhistory",
      "/executions/example?tab=history",
    ],
    ["%252Fto-dos", "/to-dos"],
    ["https://evil.example", "/"],
    ["%252F%252Fevil.example", "/"],
    ["/\\evil.example", "/"],
    ["/\\localhost:1234", "/"],
    ["/\\localhost", "/"],
    ["/api/auth/logout", "/"],
    ["/login?redirect=/to-dos", "/"],
    ["/logout", "/"],
    ["%ZZ", "/"],
    ["", "/"],
  ])("secret login safely redirects %s", async (redirect, expected) => {
    const replace = vi.fn()
    const fetch = vi.fn(async () => Response.json({ success: true }))
    globalThis.fetch = fetch
    Object.defineProperty(globalThis, "FormData", {
      configurable: true,
      writable: true,
      value: class {
        get() {
          return "pfds_test"
        }
      },
    })
    await act(async () => {
      root.render(
        <LoginFormContent
          hasPasskey={false}
          oauthProviders={[]}
          secretLoginEnabled
          searchParams={new URLSearchParams({ redirect })}
        />,
      )
    })
    const form = container.querySelector("form")!
    const submit = new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { location: { replace, origin: "https://console.example.com" } },
    })
    await act(async () => {
      form.dispatchEvent(submit)
    })
    expect(replace).toHaveBeenCalledWith(
      `https://console.example.com${expected}`,
    )
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/delegation",
      expect.objectContaining({
        body: JSON.stringify({ secret: "pfds_test" }),
      }),
    )
  })

  test("uses dummy bypass copy when the callback provides a user", async () => {
    window.history.pushState(
      null,
      "",
      "/login?error=not_authorized&dummy_bypass_user=missing%40example.com",
    )

    await act(async () => {
      root.render(
        <LoginFormContent
          hasPasskey={false}
          oauthProviders={[]}
          searchParams={new URLSearchParams(window.location.search)}
        />,
      )
    })

    expect(container.textContent).toContain(
      "Dummy login requires an existing user, but the given bypass user missing@example.com does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.",
    )
  })

  test("uses generic access-denied copy for invalid dummy bypass users", async () => {
    window.history.pushState(
      null,
      "",
      "/login?error=not_authorized&dummy_bypass_user=not-an-email",
    )

    await act(async () => {
      root.render(
        <LoginFormContent
          hasPasskey={false}
          oauthProviders={[]}
          searchParams={new URLSearchParams(window.location.search)}
        />,
      )
    })

    expect(container.textContent).toContain(
      "You don't have permission to access this application.",
    )
    expect(container.textContent).not.toContain("PF_BYPASS_AUTH")
  })

  test("uses theme colors for the passkey and OAuth divider", async () => {
    await act(async () => {
      root.render(
        <LoginFormContent
          hasPasskey
          oauthProviders={["google"]}
          searchParams={new URLSearchParams()}
        />,
      )
    })

    const label = Array.from(container.querySelectorAll("span")).find(
      (span) => span.textContent?.trim() === "Or continue with",
    )
    const rule = label?.parentElement?.previousElementSibling?.firstElementChild

    expect(label?.classList).toContain("bg-background")
    expect(label?.classList).toContain("text-muted-foreground")
    expect(label?.classList).not.toContain("bg-white")
    expect(rule?.classList).toContain("border-border")
  })
})

const installDom = (url: string): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousHTMLElement = globalThis.HTMLElement

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: dom.window,
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: dom.window.document,
  })
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: dom.window.HTMLElement,
  })

  return () => {
    rootSafeClose(dom.window)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: previousWindow,
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: previousDocument,
    })
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      writable: true,
      value: previousHTMLElement,
    })
  }
}

const rootSafeClose = (window: Window): void => {
  window.close()
}
