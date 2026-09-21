import { Data, Effect } from "effect"
import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import type { PasskeyCredential } from "../lib/auth/passkeys"
import { canOpenPasskeysMenu } from "../lib/auth/passkeys-menu"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

let authenticated = true
mock.module("@/lib/auth/session", () => ({
  getSessionWithToken: Effect.suspend(() =>
    authenticated
      ? Effect.succeed({ accessToken: "server-session-token" })
      : Effect.fail(
          new (Data.TaggedError("NoAccessTokenError"))({
            message: "private-session-error",
          }),
        ),
  ),
}))
mock.module("@/lib/auth/issuer", () => ({
  getIssuerUrl: () => "https://auth.example.test",
}))

const startRegistration = mock(async () => ({
  id: "new-credential",
  rawId: "new-credential",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "c",
    attestationObject: "a",
    transports: ["internal"],
  },
}))
mock.module("@simplewebauthn/browser", () => ({
  startRegistration,
}))

const {
  listPasskeys,
  removePasskey,
  renamePasskey,
  startPasskeyEnrollment,
  verifyPasskeyEnrollment,
} = await import("../app/(protected)/passkeys/actions")
const { PasskeysClient } = await import(
  "../app/(protected)/passkeys/passkeys-client"
)

const enrollmentOptions = {
  challenge: "c",
  rp: { id: "localhost", name: "Test" },
  user: { id: "dXNlcg", name: "owner@example.com", displayName: "Owner" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
}

const unnamed: PasskeyCredential = {
  id: "pkc-1",
  name: null,
  createdAt: "2026-01-02T03:04:00.000Z",
  lastUsedAt: null,
}
const named: PasskeyCredential = {
  id: "pkc-2",
  name: "Spare key",
  createdAt: "2026-02-03T04:05:00.000Z",
  lastUsedAt: "2026-03-04T05:06:00.000Z",
}
const listBody = {
  organisation: { name: "Example Organisation" },
  account: { userId: "owner-id", email: "owner@example.test" },
  credentials: [unnamed, named],
}
const originalFetch = globalThis.fetch

describe("passkey management server actions", () => {
  beforeEach(() => {
    authenticated = true
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("lists credentials from the issuer with the current session", async () => {
    const request = mock(async () => Response.json(listBody))
    globalThis.fetch = request
    expect(await listPasskeys()).toEqual({ kind: "success", ...listBody })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toBe("https://auth.example.test/oauth/passkeys")
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer server-session-token",
      }),
    )
    expect(init?.cache).toBe("no-store")
  })

  test("does not forward another account's identity", async () => {
    const request = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://auth.example.test/oauth/passkeys")
      return Response.json(listBody)
    })
    globalThis.fetch = request
    await listPasskeys()
  })

  test("denies HTTP 403 without exposing backend errors", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "management_denied" }, { status: 403 }),
    )
    expect(await listPasskeys()).toEqual({
      kind: "denied",
      message:
        "Passkey management is not available for this account in this organisation.",
    })
  })

  test("rejects blank names before calling the issuer", async () => {
    const request = mock()
    globalThis.fetch = request
    expect(await renamePasskey({ id: "pkc-1", name: "   " })).toEqual({
      kind: "error",
      message: "Enter a name for this Passkey.",
    })
    expect(request).not.toHaveBeenCalled()
  })

  test("renames through PATCH and returns the updated list", async () => {
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("PATCH")
        expect(JSON.parse(await new Response(init?.body).text())).toEqual({
          id: "pkc-1",
          name: "Laptop key",
        })
        return Response.json({
          ...listBody,
          credentials: [{ ...unnamed, name: "Laptop key" }, named],
        })
      },
    )
    globalThis.fetch = request
    const result = await renamePasskey({ id: "pkc-1", name: "Laptop key" })
    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(result.credentials[0]?.name).toBe("Laptop key")
  })

  test("starts enrollment with the current session and a chosen name", async () => {
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST")
        expect(JSON.parse(await new Response(init?.body).text())).toEqual({
          name: "Spare key",
        })
        return Response.json({
          challengeId: "challenge-1",
          options: enrollmentOptions,
        })
      },
    )
    globalThis.fetch = request
    expect(await startPasskeyEnrollment({ name: "Spare key" })).toEqual({
      kind: "options",
      challengeId: "challenge-1",
      options: enrollmentOptions,
    })
  })

  test("rejects malformed enrollment options at the server boundary", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ challengeId: "challenge", options: { challenge: "c" } }),
    )
    expect(await startPasskeyEnrollment({ name: "Spare" })).toEqual({
      kind: "error",
      message: "Unable to start Passkey registration.",
    })
  })

  test("rejects a blank enrollment name before calling the issuer", async () => {
    const request = mock()
    globalThis.fetch = request
    expect(await startPasskeyEnrollment({ name: "   " })).toEqual({
      kind: "error",
      message: "Enter a name for this Passkey.",
    })
    expect(request).not.toHaveBeenCalled()
  })

  test("maps a duplicate credential response without treating it as success", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "already_registered" }, { status: 409 }),
    )
    expect(
      await verifyPasskeyEnrollment({
        challengeId: "challenge-1",
        response: { id: "dup" },
      }),
    ).toEqual({
      kind: "already_registered",
      message:
        "This Passkey is already registered. Try a different authenticator.",
    })
  })

  test("removes through DELETE and returns the updated list", async () => {
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE")
        expect(JSON.parse(await new Response(init?.body).text())).toEqual({
          id: "pkc-1",
        })
        return Response.json({
          ...listBody,
          credentials: [named],
        })
      },
    )
    globalThis.fetch = request
    const result = await removePasskey({ id: "pkc-1" })
    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(result.credentials).toEqual([named])
  })

  test("explains last-credential rejection without exposing backend errors", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "last_credential" }, { status: 409 }),
    )
    expect(await removePasskey({ id: "pkc-1" })).toEqual({
      kind: "error",
      message: "Add a replacement Passkey before removing this one.",
    })
  })
})

describe("passkey management page", () => {
  let dom: JSDOM
  let root: Root
  let container: HTMLElement
  const globals = new Map<string, PropertyDescriptor | undefined>()

  beforeEach(() => {
    authenticated = true
    startRegistration.mockReset()
    startRegistration.mockImplementation(async () => ({
      id: "new-credential",
      rawId: "new-credential",
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: "c",
        attestationObject: "a",
        transports: ["internal"],
      },
    }))
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://app.example.test/passkeys",
    })
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      FormData: dom.window.FormData,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        configurable: true,
      })
    }
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    globalThis.fetch = originalFetch
  })

  test("shows organisation scope, unnamed fallback, last-used, dates, and renaming", async () => {
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return Response.json({
            ...listBody,
            credentials: [
              { ...unnamed, name: "Laptop key" },
              { ...named, name: "Laptop key" },
            ],
          })
        }
        return Response.json(listBody)
      },
    )
    globalThis.fetch = request

    await act(async () => {
      root.render(
        <PasskeysClient
          organisationName="Example Organisation"
          account={listBody.account}
          initialCredentials={[unnamed, named]}
        />,
      )
    })

    expect(container.textContent).toContain(
      "These Passkeys belong to owner@example.test in Example Organisation",
    )
    expect(container.textContent).toContain("Unnamed passkey")
    expect(container.textContent).toContain("Spare key")
    expect(container.innerHTML).toContain('datetime="2026-01-02T03:04:00.000Z"')
    expect(container.textContent).toContain("Last used: Unknown")
    expect(container.innerHTML).toContain('datetime="2026-03-04T05:06:00.000Z"')
    expect(container.textContent).not.toContain("this device")

    const input = container.querySelector(
      'input[aria-label="Name for Unnamed passkey"]',
    ) as HTMLInputElement
    expect(input.value).toBe("")
    input.value = "Laptop key"
    const form = input.closest("form")
    expect(form).not.toBeNull()
    await act(async () => {
      form?.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(container.textContent).toContain("Passkey name saved.")
    expect(container.textContent).toContain("Laptop key")
    expect(container.textContent).toContain("Last used: Unknown")
    expect(container.innerHTML).toContain('datetime="2026-03-04T05:06:00.000Z"')
  })

  test("adds a named Passkey after a completed ceremony", async () => {
    startRegistration.mockClear()
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(await new Response(init.body).text()) as {
            name?: string
          }
          if (body.name === "Hardware key") {
            return Response.json({
              challengeId: "challenge-1",
              options: enrollmentOptions,
            })
          }
          return Response.json({
            ...listBody,
            credentials: [
              unnamed,
              named,
              {
                id: "pkc-3",
                name: "Hardware key",
                createdAt: "2026-03-04T05:06:00.000Z",
                lastUsedAt: null,
              },
            ],
          })
        }
        return Response.json(listBody)
      },
    )
    globalThis.fetch = request

    await act(async () => {
      root.render(
        <PasskeysClient
          organisationName="Example Organisation"
          account={listBody.account}
          initialCredentials={[unnamed, named]}
        />,
      )
    })

    const input = container.querySelector(
      'input[aria-label="Name for the new Passkey"]',
    ) as HTMLInputElement
    input.value = "Hardware key"
    const form = container.querySelector(
      '[data-testid="add-passkey-form"]',
    ) as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(startRegistration).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("Passkey added.")
    expect(container.textContent).toContain("Hardware key")
  })

  test("explains cancellation and already-registered authenticators without adding a credential", async () => {
    startRegistration.mockClear()
    startRegistration.mockImplementationOnce(async () => {
      const error = new Error(
        "The operation either timed out or was not allowed.",
      )
      error.name = "NotAllowedError"
      throw error
    })
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({
            challengeId: "challenge-1",
            options: enrollmentOptions,
          })
        }
        return Response.json(listBody)
      },
    )
    globalThis.fetch = request

    await act(async () => {
      root.render(
        <PasskeysClient
          organisationName="Example Organisation"
          account={listBody.account}
          initialCredentials={[unnamed, named]}
        />,
      )
    })

    const form = () =>
      container.querySelector(
        '[data-testid="add-passkey-form"]',
      ) as HTMLFormElement
    const nameInput = () =>
      container.querySelector(
        'input[aria-label="Name for the new Passkey"]',
      ) as HTMLInputElement
    nameInput().value = "Spare key"
    await act(async () => {
      form().dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(container.textContent).toContain(
      "Registration was cancelled. You can try again.",
    )
    expect(container.querySelectorAll("[data-passkey-id]")).toHaveLength(2)

    startRegistration.mockImplementationOnce(async () => {
      const error = new Error("The authenticator was previously registered")
      Object.assign(error, {
        code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
      })
      throw error
    })
    nameInput().value = "Spare key"
    await act(async () => {
      form().dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(container.textContent).toContain(
      "This Passkey is already registered. Try a different authenticator.",
    )
    expect(container.querySelectorAll("[data-passkey-id]")).toHaveLength(2)
  })

  test("confirms removal, explains remaining sessions, and updates the list", async () => {
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE")
        return Response.json({
          ...listBody,
          credentials: [named],
        })
      },
    )
    globalThis.fetch = request

    await act(async () => {
      root.render(
        <PasskeysClient
          organisationName="Example Organisation"
          account={listBody.account}
          initialCredentials={[unnamed, named]}
        />,
      )
    })

    const remove = container.querySelector(
      'button[aria-label="Remove Unnamed passkey"]',
    ) as HTMLButtonElement
    expect(remove).not.toBeNull()
    await act(async () => {
      remove.click()
    })
    expect(container.textContent).toContain(
      "This Passkey will no longer be able to sign in. Existing sessions remain signed in.",
    )
    const confirm = container.querySelector(
      '[data-testid="passkey-confirm-remove"]',
    ) as HTMLButtonElement
    expect(confirm).not.toBeNull()
    await act(async () => {
      confirm.click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain("Passkey removed.")
    expect(container.textContent).not.toContain("Unnamed passkey")
    expect(container.textContent).toContain("Spare key")
    expect(request).toHaveBeenCalledTimes(1)
  })

  test("rejects removing the final Passkey without calling the issuer", async () => {
    const request = mock()
    globalThis.fetch = request

    await act(async () => {
      root.render(
        <PasskeysClient
          organisationName="Example Organisation"
          account={listBody.account}
          initialCredentials={[named]}
        />,
      )
    })

    const remove = container.querySelector(
      'button[aria-label="Remove Spare key"]',
    ) as HTMLButtonElement
    await act(async () => {
      remove.click()
    })
    expect(container.textContent).toContain(
      "Add a replacement Passkey before removing this one.",
    )
    expect(container.textContent).not.toContain("Existing sessions remain")
    expect(request).not.toHaveBeenCalled()
  })

  test("profile Passkeys follows listing authorization only", () => {
    expect(canOpenPasskeysMenu(undefined)).toBe(false)
    expect(canOpenPasskeysMenu({ kind: "denied" })).toBe(false)
    expect(canOpenPasskeysMenu({ kind: "error" })).toBe(false)
    expect(canOpenPasskeysMenu({ kind: "success" })).toBe(true)
  })
})
