import { Data, Effect } from "effect"
import { JSDOM } from "jsdom"
import { Activity, type ComponentProps, act } from "react"
import { type Root, createRoot, hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import type { DelegationMetadata } from "../lib/auth/delegations"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

let authenticated = true
let sessionErrorTag: Effect.Effect.Error<
  typeof import("../lib/auth/session").getSessionWithToken
>["_tag"] = "NoAccessTokenError"
let accessToken = "server-session-token"
mock.module("@/lib/auth/session", () => ({
  getSessionWithToken: Effect.suspend(() =>
    authenticated
      ? Effect.succeed({ accessToken })
      : Effect.fail(
          new (Data.TaggedError(sessionErrorTag))({
            message: "private-session-error",
          }),
        ),
  ),
}))
mock.module("@/lib/auth/issuer", () => ({
  getIssuerUrl: () => "https://auth.example.test",
}))

const verifyPasskey = mock(async () => {})
mock.module("@/lib/auth/verify-passkey", () => ({
  authenticateWithPasskey: verifyPasskey,
}))

const { createDelegation, listDelegations, updateDelegation } = await import(
  "../app/(protected)/act-on-behalf/actions"
)
const { DelegationsClient: Management } = await import(
  "../app/(protected)/act-on-behalf/delegations-client"
)
const listDefaults = {
  owner: { userId: "owner-session-id", email: "owner@example.test" },
  canIssue: true,
  issuanceDeadline: null,
}
function DelegationsClient(
  props: Omit<
    ComponentProps<typeof Management>,
    "owner" | "initialCanIssue" | "initialIssuanceDeadline" | "initialNow"
  >,
) {
  return (
    <Management
      owner={listDefaults.owner}
      initialCanIssue
      initialIssuanceDeadline={null}
      initialNow={Date.now()}
      {...props}
    />
  )
}
const metadata = {
  id: "delegation-1",
  name: "invoice-agent",
  generationId: "generation-1",
  createdAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2020-01-02T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "expired",
  allowedActions: { rename: true, replace: true, revoke: true },
} satisfies DelegationMetadata
const originalFetch = globalThis.fetch

describe("delegation server actions", () => {
  beforeEach(() => {
    authenticated = true
    sessionErrorTag = "NoAccessTokenError"
    accessToken = "server-session-token"
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("forwards an encoded external owner user ID for GET, POST and PATCH", async () => {
    const ownerUserId = "external|owner+id&not=a-query"
    const request = mock(
      async (_url: string | URL | Request, init?: RequestInit) =>
        Response.json(
          init?.method
            ? { ...metadata, secret: "issued-once" }
            : {
                ...listDefaults,
                delegations: [metadata],
              },
        ),
    )
    globalThis.fetch = request
    expect((await listDelegations(ownerUserId)).kind).toBe("success")
    expect(
      (await createDelegation({ name: "agent", lifetimeDays: 1 }, ownerUserId))
        .kind,
    ).toBe("success")
    expect(
      (
        await updateDelegation(
          {
            operation: "revoke",
            id: metadata.id,
            generationId: metadata.generationId,
            expectedName: metadata.name,
          },
          ownerUserId,
        )
      ).kind,
    ).toBe("success")
    expect(request).toHaveBeenCalledTimes(3)
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe(
        `https://auth.example.test/delegations?${new URLSearchParams({ ownerUserId })}`,
      )
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer server-session-token",
        }),
      )
      expect(init?.cache).toBe("no-store")
    }
  })

  test("distinguishes metadata denial without returning owner data or backend errors", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { ...listDefaults, error: "sensitive-denial", delegations: [metadata] },
        { status: 403 },
      ),
    )
    expect(await listDelegations("another-owner")).toEqual({
      kind: "denied",
      message:
        "You are not permitted to inspect this owner's Delegation Tokens.",
    })
  })

  test("denies HTTP 401 without exposing response data", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ...listDefaults, secret: "private" }, { status: 401 }),
    )
    expect(await listDelegations()).toEqual({
      kind: "denied",
      message: "Your session is unavailable or has expired. Log in again.",
    })
  })

  test.each(["NoAccessTokenError", "JWTVerificationError"] as const)(
    "denies %s before fetching metadata",
    async (tag) => {
      authenticated = false
      sessionErrorTag = tag
      const request = mock()
      globalThis.fetch = request
      expect(await listDelegations()).toEqual({
        kind: "denied",
        message: "Your session is unavailable or has expired. Log in again.",
      })
      expect(request).not.toHaveBeenCalled()
    },
  )

  test("keeps metadata network failure transient", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("offline")
    })
    expect(await listDelegations()).toEqual({
      kind: "error",
      message: "Unable to load delegated access.",
    })
  })

  test.each([1, 7, 14])(
    "forwards the %i-day choice with server credentials and no cache",
    async (lifetimeDays) => {
      const request = mock(() =>
        Promise.resolve(
          Response.json({
            ...metadata,
            secret: "one-time-secret",
            verifier: "not-for-browser",
          }),
        ),
      )
      globalThis.fetch = request as typeof fetch
      const result = await createDelegation({
        name: " invoice-agent ",
        lifetimeDays,
        accessToken: "forged",
        ownerId: "other-user",
      })
      expect(request).toHaveBeenCalledWith(
        "https://auth.example.test/delegations",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer server-session-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "invoice-agent", lifetimeDays }),
          cache: "no-store",
          redirect: "error",
        },
      )
      expect(result).toEqual({
        kind: "success",
        data: { ...metadata, secret: "one-time-secret" },
      })
    },
  )

  test("rejects unsupported lifetimes and empty names before any request", async () => {
    const request = mock()
    globalThis.fetch = request as typeof fetch
    for (const input of [
      { name: "agent", lifetimeDays: 30 },
      { name: " ", lifetimeDays: 1 },
      null,
    ]) {
      expect((await createDelegation(input)).kind).toBe("error")
    }
    expect(request).not.toHaveBeenCalled()
  })

  test.each([
    { operation: "rename", name: " renamed-agent " },
    ...[1, 7, 14].map((lifetimeDays) => ({
      operation: "replace",
      name: " renamed-agent ",
      lifetimeDays,
    })),
    { operation: "revoke" },
  ])(
    "validates and forwards lifecycle operation %j with stale guards",
    async (operation) => {
      const request = mock(() =>
        Promise.resolve(
          Response.json({
            ...metadata,
            secret: "replacement-secret",
            verifier: "private",
          }),
        ),
      )
      globalThis.fetch = request as typeof fetch
      const guards = {
        id: metadata.id,
        generationId: metadata.generationId,
        expectedName: metadata.name,
      }
      const result = await updateDelegation({
        ...guards,
        ...operation,
        ownerId: "forged",
        accessToken: "forged",
      })
      expect(request).toHaveBeenCalledWith(
        "https://auth.example.test/delegations",
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer server-session-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            operation: operation.operation,
            ...guards,
            ...("name" in operation ? { name: "renamed-agent" } : {}),
            ...("lifetimeDays" in operation
              ? { lifetimeDays: operation.lifetimeDays }
              : {}),
          }),
          cache: "no-store",
          redirect: "error",
        },
      )
      expect(result).toEqual({
        kind: "success",
        data:
          operation.operation === "replace"
            ? { ...metadata, secret: "replacement-secret" }
            : metadata,
      })
    },
  )

  test("rejects invalid lifecycle requests before fetching", async () => {
    const request = mock()
    globalThis.fetch = request as typeof fetch
    const valid = {
      operation: "replace",
      id: metadata.id,
      generationId: metadata.generationId,
      expectedName: metadata.name,
      name: "agent",
      lifetimeDays: 1,
    }
    for (const input of [
      null,
      { ...valid, operation: "extend" },
      { ...valid, generationId: "" },
      { ...valid, expectedName: "" },
      { ...valid, name: " " },
      { ...valid, lifetimeDays: 30 },
    ]) {
      expect((await updateDelegation(input)).kind).toBe("error")
    }
    authenticated = false
    expect((await updateDelegation(valid)).kind).toBe("denied")
    expect(request).not.toHaveBeenCalled()
  })

  test.each([
    [409, "name_conflict", "Choose another name", false],
    [409, "stale_delegation", "changed elsewhere", true],
    [403, "operation_denied", "no longer permitted", true],
    [403, "issuance_denied", "not permitted", false],
    [404, "not_found", "no longer available", true],
    [500, "sensitive-value", "Unable to update", true],
  ] as const)(
    "handles lifecycle error %i/%s safely",
    async (status, error, message, reloadRequired) => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({ error, secret: "private-error-secret" }, { status }),
        ),
      ) as typeof fetch
      const result = await updateDelegation({
        operation: "revoke",
        id: metadata.id,
        generationId: metadata.generationId,
        expectedName: metadata.name,
      })
      expect(result).toEqual({
        kind: "error",
        message: expect.stringContaining(message),
        reloadRequired,
      })
      expect(JSON.stringify(result)).not.toContain("private-error-secret")
      expect(JSON.stringify(result)).not.toContain("sensitive-value")
    },
  )

  test("requires a server-verified session for both actions", async () => {
    authenticated = false
    const request = mock()
    globalThis.fetch = request as typeof fetch
    expect((await listDelegations()).kind).toBe("denied")
    expect(
      (await createDelegation({ name: "agent", lifetimeDays: 1 })).kind,
    ).toBe("denied")
    expect(request).not.toHaveBeenCalled()
  })

  test.each(["active", "expired", "revoked"])(
    "preserves server status %s without exposing secret fields",
    async (status) => {
      const request = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [
              {
                ...metadata,
                status,
                secret: "must-not-leak",
                verifier: "must-not-leak",
              },
            ],
          }),
        ),
      )
      globalThis.fetch = request as typeof fetch
      expect(await listDelegations()).toEqual({
        kind: "success",
        ...listDefaults,
        delegations: [{ ...metadata, status }],
      })
      expect(request).toHaveBeenCalledWith(
        "https://auth.example.test/delegations",
        expect.objectContaining({
          cache: "no-store",
          headers: { Authorization: "Bearer server-session-token" },
        }),
      )
    },
  )

  test.each([undefined, "unknown"])(
    "rejects invalid server status %s",
    async (status) => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [{ ...metadata, status }],
          }),
        ),
      ) as typeof fetch
      expect((await listDelegations()).kind).toBe("error")
    },
  )

  test("ignores a legacy enabled field in management responses", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({ ...listDefaults, enabled: false, delegations: [] }),
      ),
    ) as typeof fetch
    expect(await listDelegations()).toEqual({
      kind: "success",
      ...listDefaults,
      delegations: [],
    })
  })

  test.each([null, "2030-01-01T12:00:00.000Z", "invalid-date"])(
    "parses the trusted issuance deadline %s at the server boundary",
    async (issuanceDeadline) => {
      globalThis.fetch = mock(async () =>
        Response.json({
          ...listDefaults,
          delegations: [],
          issuanceDeadline,
        }),
      )
      const result = await listDelegations()
      if (issuanceDeadline === "invalid-date") expect(result.kind).toBe("error")
      else expect(result).toMatchObject({ kind: "success", issuanceDeadline })
    },
  )

  test.each([403, 409, 500])(
    "does not disclose backend error bodies (%i)",
    async (status) => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({ error: "sensitive-value" }, { status }),
        ),
      ) as typeof fetch
      const result = await createDelegation({ name: "agent", lifetimeDays: 7 })
      expect(result.kind).toBe("error")
      expect(JSON.stringify(result)).not.toContain("sensitive-value")
    },
  )
})

describe("delegation management interaction", () => {
  let dom: JSDOM
  let root: Root
  let container: HTMLDivElement
  const globals = new Map<string, PropertyDescriptor | undefined>()
  const copy = mock(() => Promise.resolve())
  beforeEach(() => {
    authenticated = true
    sessionErrorTag = "NoAccessTokenError"
    accessToken = "server-session-token"
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://app.example.test/act-on-behalf",
    })
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      FormData: dom.window.FormData,
      HTMLElement: dom.window.HTMLElement,
      navigator: { clipboard: { writeText: copy } },
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
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({ ...metadata, secret: "transient-secret" }),
      ),
    ) as typeof fetch
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    globalThis.fetch = originalFetch
    copy.mockClear()
    verifyPasskey.mockReset()
  })

  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === text,
    )!
  const submitManagement = async () => {
    await act(async () => {
      container
        .querySelector("article form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        )
    })
  }

  const submitMutation = async (action: string) => {
    if (action !== "Create secret") {
      await act(async () => button(action).click())
      await submitManagement()
      return
    }
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
      "new-agent"
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        )
    })
  }

  for (const action of ["Create secret", "Regenerate"] as const) {
    for (const outcome of [
      "success",
      "cancel",
      "failure",
      "denied",
      "stale",
    ] as const) {
      test(`${action} preserves intent through ${outcome} verification and blocks duplicate submission`, async () => {
        await act(async () =>
          root.render(<DelegationsClient initialDelegations={[metadata]} />),
        )
        const ceremony = Promise.withResolvers<void>()
        verifyPasskey.mockImplementation(() => ceremony.promise)
        const bodies: unknown[] = []
        globalThis.fetch = mock(
          async (_url: unknown, options?: RequestInit) => {
            bodies.push(JSON.parse(String(options?.body)))
            if (bodies.length === 1 || outcome === "stale")
              return Response.json(
                { error: "verification_required" },
                { status: 403 },
              )
            if (outcome === "denied")
              return Response.json(
                { error: "issuance_denied" },
                { status: 403 },
              )
            return Response.json({
              ...metadata,
              secret: "resumed-secret",
              generationId: "resumed-generation",
            })
          },
        )
        if (action === "Regenerate")
          await act(async () => button("Regenerate").click())
        const form = container.querySelector<HTMLFormElement>(
          action === "Regenerate" ? "article form" : "form",
        )!
        form.querySelector<HTMLInputElement>('input[name="name"]')!.value =
          "preserved-name"
        await act(async () =>
          form.querySelector<HTMLInputElement>('input[value="7"]')!.click(),
        )
        const submit = () =>
          form.dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          )
        await act(async () => {
          submit()
          submit()
        })
        expect(bodies).toHaveLength(1)
        expect(verifyPasskey).toHaveBeenCalledTimes(1)
        expect(container.textContent).toContain(
          action === "Regenerate"
            ? "Verify with your passkey to regenerate this secret"
            : "Verify with your passkey to create this token",
        )
        expect(container.querySelector("code[data-private]")).toBeNull()
        await act(async () => {
          if (outcome === "cancel") {
            button("Cancel verification").click()
            ceremony.reject(new DOMException("cancelled", "NotAllowedError"))
          } else if (outcome === "failure")
            ceremony.reject(new Error("wrong owner"))
          else ceremony.resolve()
        })
        expect(bodies).toHaveLength(
          outcome === "cancel" || outcome === "failure" ? 1 : 2,
        )
        if (bodies.length === 2) expect(bodies[1]).toEqual(bodies[0])
        expect(bodies[0]).toMatchObject({
          name: "preserved-name",
          lifetimeDays: 7,
        })
        if (action === "Regenerate")
          expect(bodies[0]).toMatchObject({
            id: metadata.id,
            generationId: metadata.generationId,
            expectedName: metadata.name,
          })
        if (outcome === "success") {
          expect(
            container.querySelector("code[data-private]")?.textContent,
          ).toBe("resumed-secret")
        } else {
          expect(container.querySelector("code[data-private]")).toBeNull()
          expect(
            form.querySelector<HTMLInputElement>('input[name="name"]')!.value,
          ).toBe("preserved-name")
          expect(
            form.querySelector<HTMLInputElement>('input[value="7"]')!.checked,
          ).toBe(true)
          expect(
            form.querySelector<HTMLButtonElement>('button[type="submit"]')!
              .disabled,
          ).toBe(false)
        }
        expect(verifyPasskey).toHaveBeenCalledTimes(1)
        expect(dom.window.sessionStorage.length).toBe(0)
        expect(dom.window.localStorage.length).toBe(0)
      })
    }
  }

  test.each(
    ["Create secret", "Rename", "Revoke", "Regenerate"].flatMap((action) =>
      (
        [
          401,
          "NoAccessTokenError",
          "JWTVerificationError",
          "offline",
          403,
        ] as const
      ).map((failure) => ({ action, failure })),
    ),
  )(
    "$action handles $failure immediately without polling",
    async ({ action, failure }) => {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[metadata]} />),
      )
      const request = mock(async () => {
        if (failure === "offline") throw new TypeError("private-network-error")
        return new Response(null, {
          status: typeof failure === "number" ? failure : 500,
        })
      })
      globalThis.fetch = request
      if (
        failure === "NoAccessTokenError" ||
        failure === "JWTVerificationError"
      ) {
        authenticated = false
        sessionErrorTag = failure
      }
      await submitMutation(action)
      expect(request).toHaveBeenCalledTimes(authenticated ? 1 : 0)
      expect(container.textContent).not.toContain("private-")
      if (failure === "offline" || failure === 403) {
        expect(container.textContent).not.toContain("Log in again")
        expect(container.innerHTML).toContain(metadata.id)
        expect(container.textContent).not.toContain(listDefaults.owner.email)
        expect(button("Create secret")).toBeDefined()
        expect(button("Create secret").disabled).toBe(
          action !== "Create secret",
        )
        if (action !== "Create secret") {
          expect(container.querySelector("article form")).not.toBeNull()
          expect(
            container.querySelector<HTMLButtonElement>(
              'article button[type="submit"]',
            )?.disabled,
          ).toBe(true)
        }
        return
      }
      expect(container.textContent).toContain("Log in again")
      expect(container.textContent).not.toContain(listDefaults.owner.email)
      expect(container.textContent).not.toContain(listDefaults.owner.userId)
      expect(container.innerHTML).not.toContain(metadata.id)
      expect(container.querySelector("article")).toBeNull()
      expect(container.querySelector("form")).toBeNull()
      expect(container.querySelector("code")).toBeNull()
      expect(button("Create secret")).toBeUndefined()
      expect(button("Authenticate again with Passkey")).toBeUndefined()
    },
  )

  test.each(["Create secret", "Rename", "Revoke", "Regenerate"])(
    "late clipboard completion cannot overwrite %s session denial",
    async (action) => {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[metadata]} />),
      )
      await submitMutation("Regenerate")
      expect(container.textContent).toContain("transient-secret")
      const copied = Promise.withResolvers<void>()
      copy.mockImplementationOnce(() => copied.promise)
      await act(async () => button("Copy secret").click())
      await act(async () => button("I have saved it").click())
      globalThis.fetch = mock(async () => new Response(null, { status: 401 }))
      await submitMutation(action)
      await act(async () => copied.resolve())
      expect(container.textContent).toContain("Log in again")
      expect(container.textContent).not.toContain("Secret copied")
      expect(container.textContent).not.toContain("transient-secret")
      expect(container.querySelector("code")).toBeNull()
      expect(container.querySelector("article")).toBeNull()
      expect(container.querySelector("form")).toBeNull()
    },
  )

  test.each(["Create secret", "Rename", "Revoke", "Regenerate"])(
    "late polling cannot restore access after %s rejects the session",
    async (action) => {
      let tick = () => {}
      const timer = spyOn(window, "setInterval").mockImplementation(
        (handler) => {
          if (typeof handler === "function")
            tick = () => {
              handler()
            }
          return 1
        },
      )
      try {
        await act(async () =>
          root.render(<DelegationsClient initialDelegations={[metadata]} />),
        )
        const snapshot = Promise.withResolvers<Response>()
        globalThis.fetch = mock(() => snapshot.promise)
        await act(async () => {
          tick()
        })
        globalThis.fetch = mock(async () => new Response(null, { status: 401 }))
        await submitMutation(action)
        expect(container.textContent).toContain("Log in again")
        await act(async () =>
          snapshot.resolve(
            Response.json({
              ...listDefaults,
              delegations: [metadata],
            }),
          ),
        )
        expect(container.textContent).toContain("Log in again")
        expect(container.textContent).not.toContain(listDefaults.owner.email)
        expect(container.querySelector("article")).toBeNull()
        expect(container.querySelector("form")).toBeNull()
        expect(button("Authenticate again with Passkey")).toBeUndefined()
      } finally {
        timer.mockRestore()
      }
    },
  )

  test("personal management leads with collapsed creation and no owner identifiers", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[]} />),
    )
    expect(container.querySelector("details")?.open).toBe(false)
    expect(container.querySelector("summary")?.textContent).toBe("Create token")
    expect(container.textContent).toContain("You have no tokens yet")
    expect(container.textContent).not.toContain(listDefaults.owner.email)
    expect(container.textContent).not.toContain(listDefaults.owner.userId)
    expect(container.querySelector('[name="ownerUserId"]')).toBeNull()
    expect(container.querySelector('a[href="/act-on-behalf"]')).toBeNull()
  })

  test.each([
    "human-administrator",
    "explicitly-permitted-delegated-administrator",
  ])(
    "%s can inspect and revoke without issuance or disclosure",
    async (actor) => {
      accessToken = actor
      const token = {
        ...metadata,
        lastUsedAt: "2020-01-01T12:00:00.000Z",
        allowedActions: { rename: false, replace: false, revoke: true },
      }
      await act(async () =>
        root.render(
          <Management
            initialIssuanceDeadline={null}
            initialNow={Date.now()}
            owner={listDefaults.owner}
            ownerUserId={listDefaults.owner.userId}
            initialCanIssue={false}
            initialDelegations={[token]}
          />,
        ),
      )
      expect(container.textContent).toContain(listDefaults.owner.email)
      expect(container.textContent).not.toContain(listDefaults.owner.userId)
      expect(container.innerHTML).toContain(token.lastUsedAt)
      expect(container.textContent).toContain(token.id)
      expect(container.textContent).toContain(token.generationId)
      expect(container.innerHTML).toContain(token.expiresAt)
      expect(container.textContent).toContain("Expired")
      expect(container.textContent).not.toContain("Create secret")
      expect(container.textContent).not.toContain("Regenerate")
      expect(container.textContent).not.toContain("Authenticate again")
      expect(button("Rename")).toBeUndefined()
      const request = mock(async () =>
        Response.json({
          ...token,
          status: "revoked",
          allowedActions: { rename: false, replace: false, revoke: false },
          secret: "must-never-reveal",
          verifier: "must-never-reveal",
        }),
      )
      globalThis.fetch = request
      await act(async () => button("Revoke").click())
      expect(request).not.toHaveBeenCalled()
      await submitManagement()
      expect(request).toHaveBeenCalledWith(
        "https://auth.example.test/delegations?ownerUserId=owner-session-id",
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            Authorization: `Bearer ${actor}`,
          }),
        }),
      )
      expect(container.textContent).toContain("Revoked")
      expect(container.textContent).not.toContain("must-never-reveal")
      expect(container.querySelector("code")).toBeNull()
    },
  )

  test.each([403, 401, "NoAccessTokenError", "JWTVerificationError"] as const)(
    "polling removes metadata and pending controls after %s",
    async (failure) => {
      let tick = () => {}
      const timer = spyOn(window, "setInterval").mockImplementation(
        (handler) => {
          if (typeof handler === "function")
            tick = () => {
              handler()
            }
          return 1
        },
      )
      try {
        await act(async () =>
          root.render(
            <Management
              initialIssuanceDeadline={null}
              initialNow={Date.now()}
              owner={listDefaults.owner}
              ownerUserId={listDefaults.owner.userId}
              initialCanIssue={false}
              initialDelegations={[
                {
                  ...metadata,
                  allowedActions: {
                    rename: false,
                    replace: false,
                    revoke: true,
                  },
                },
              ]}
            />,
          ),
        )
        await act(async () => button("Revoke").click())
        if (typeof failure === "number") {
          globalThis.fetch = mock(
            async () => new Response(null, { status: failure }),
          )
        } else {
          authenticated = false
          sessionErrorTag = failure
        }
        await act(async () => {
          tick()
        })
        expect(container.textContent).toContain(
          failure === 403 ? "not permitted to inspect" : "Log in again",
        )
        expect(container.textContent).not.toContain(metadata.name)
        expect(container.textContent).not.toContain(listDefaults.owner.email)
        expect(container.querySelector("article")).toBeNull()
        expect(button("Confirm revocation")).toBeUndefined()
        expect(button("Create secret")).toBeUndefined()
      } finally {
        timer.mockRestore()
      }
    },
  )

  test("own management offers fresh passkey authentication without exposing denied issuance", async () => {
    await act(async () =>
      root.render(
        <Management
          initialIssuanceDeadline={null}
          initialNow={Date.now()}
          owner={listDefaults.owner}
          initialCanIssue={false}
          initialDelegations={[]}
        />,
      ),
    )
    expect(button("Create secret")).toBeUndefined()
    expect(button("Authenticate again with Passkey")).toBeUndefined()
    expect(container.querySelector('input[name="lifetimeDays"]')).toBeNull()
    expect(container.textContent).toContain(
      "Token creation is not currently permitted",
    )
    expect(container.querySelector("#reauth-heading")).toBeNull()
  })

  test.each([null, -60_000, 0, 12 * 3_600_000, 3 * 86_400_000])(
    "creation and replacement preview the shorter duration/ancestor deadline (%s)",
    async (remaining) => {
      const now = Date.parse("2030-01-01T00:00:00.000Z")
      const ancestor =
        remaining === null ? null : new Date(now + remaining).toISOString()
      await act(async () =>
        root.render(
          <Management
            owner={listDefaults.owner}
            initialCanIssue
            initialIssuanceDeadline={ancestor}
            initialNow={now}
            initialDelegations={[metadata]}
          />,
        ),
      )
      await act(async () => button("Regenerate").click())
      for (const fieldset of container.querySelectorAll("fieldset")) {
        for (const days of [1, 7, 14]) {
          await act(async () =>
            fieldset
              .querySelector<HTMLInputElement>(`input[value="${days}"]`)!
              .click(),
          )
          expect(fieldset.querySelector("time")?.dateTime).toBe(
            new Date(
              now + Math.min(days * 86_400_000, remaining ?? Infinity),
            ).toISOString(),
          )
          expect(
            fieldset.textContent?.includes("Reload to check your access"),
          ).toBe(remaining !== null && remaining <= 0)
          expect(
            fieldset.textContent?.includes("Limited by your current access"),
          ).toBe(remaining !== null)
        }
      }
      if (remaining !== null) {
        expect(button("Authenticate again with Passkey")).toBeUndefined()
        expect(container.textContent).not.toContain(
          "does not establish fresh human authentication",
        )
      }
      await submitManagement()
      expect(container.querySelector("article")?.innerHTML).toContain(
        metadata.expiresAt,
      )
      expect(container.querySelector("code[data-private]")?.textContent).toBe(
        "transient-secret",
      )
      expect(
        container.querySelector<HTMLTimeElement>(
          '[aria-labelledby="secret-heading"] time',
        )?.dateTime,
      ).toBe(metadata.expiresAt)
    },
  )

  test.each([null, 12 * 3_600_000])(
    "keeps readable estimates stable after delayed hydration and foreground (%s)",
    async (remaining) => {
      const anchor = Date.parse("2030-01-01T00:00:00.000Z")
      const clock = spyOn(Date, "now").mockReturnValue(anchor)
      const hydrationError = mock()
      const view = (
        <Management
          owner={listDefaults.owner}
          initialCanIssue
          initialIssuanceDeadline={
            remaining === null
              ? null
              : new Date(anchor + remaining).toISOString()
          }
          initialNow={anchor}
          initialDelegations={[metadata]}
        />
      )
      try {
        await act(async () => root.unmount())
        container.innerHTML = renderToString(view)
        clock.mockReturnValue(anchor + 2 * 86_400_000)
        await act(async () => {
          root = hydrateRoot(container, view, {
            onRecoverableError: hydrationError,
          })
        })
        expect(hydrationError).not.toHaveBeenCalled()
        // Simulate returning after suspended background timers, without a poll.
        clock.mockReturnValue(anchor + 4 * 86_400_000)
        await act(async () => {
          document.dispatchEvent(new dom.window.Event("visibilitychange"))
          window.dispatchEvent(new dom.window.Event("focus"))
          button("Regenerate").click()
        })
        for (const fieldset of container.querySelectorAll("fieldset")) {
          await act(async () =>
            fieldset
              .querySelector<HTMLInputElement>('input[value="7"]')!
              .click(),
          )
          expect(fieldset.querySelector("time")?.dateTime).toBe(
            new Date(
              anchor + Math.min(7 * 86_400_000, remaining ?? Infinity),
            ).toISOString(),
          )
          expect(fieldset.textContent).toContain("Estimated expiry:")
          expect(fieldset.textContent).toContain("Confirmed when created.")
          expect(fieldset.textContent).not.toContain("If issued now")
          expect(fieldset.textContent).toContain("UTC")
          if (remaining !== null)
            expect(fieldset.textContent).toContain(
              "Limited by your current access",
            )
        }
        await submitManagement()
        expect(
          container.querySelector<HTMLTimeElement>(
            '[aria-labelledby="secret-heading"] time',
          )?.dateTime,
        ).toBe(metadata.expiresAt)
      } finally {
        clock.mockRestore()
      }
    },
  )

  test("shows only independently permitted controls and never replaces revoked identities", async () => {
    await act(async () =>
      root.render(
        <DelegationsClient
          initialDelegations={[
            {
              ...metadata,
              allowedActions: { rename: true, replace: false, revoke: false },
            },
            { ...metadata, id: "revoked", status: "revoked" },
            {
              ...metadata,
              id: "replace-only",
              allowedActions: { rename: false, replace: true, revoke: false },
            },
          ]}
        />,
      ),
    )
    expect(
      Array.from(container.querySelectorAll("article")).map((row) =>
        Array.from(row.querySelectorAll("button")).map(
          (node) => node.textContent,
        ),
      ),
    ).toEqual([["Rename"], ["Rename", "Revoke"], ["Regenerate"]])
  })

  test("renames with the displayed generation and name while preserving identity and deadline", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[metadata]} />),
    )
    await act(async () => button("Rename").click())
    container.querySelector<HTMLInputElement>(
      'article input[name="name"]',
    )!.value = "new-name"
    const request = mock(() =>
      Promise.resolve(
        Response.json({
          ...metadata,
          name: "new-name",
          secret: "must-not-show",
        }),
      ),
    )
    globalThis.fetch = request as typeof fetch
    await submitManagement()
    expect(request.mock.calls).toHaveLength(1)
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          operation: "rename",
          id: metadata.id,
          generationId: metadata.generationId,
          expectedName: metadata.name,
          name: "new-name",
        }),
      }),
    )
    expect(container.querySelector("article h3")?.textContent).toBe("new-name")
    expect(
      container.querySelector("article")?.getAttribute("data-generation-id"),
    ).toBe(metadata.generationId)
    expect(container.textContent).not.toContain(metadata.generationId)
    expect(container.innerHTML).toContain(metadata.expiresAt)
    expect(container.textContent).not.toContain("must-not-show")
    expect(container.querySelector("article form")).toBeNull()
  })

  test.each([1, 7, 14])(
    "replaces an expired identity for %i days and discloses the new secret once",
    async (days) => {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[metadata]} />),
      )
      await act(async () => button("Regenerate").click())
      expect(
        container.querySelector("article form")?.getAttribute("aria-label"),
      ).toBe(`Regenerate secret for ${metadata.name}`)
      expect(button("Regenerate secret")).toBeDefined()
      expect(
        container.querySelector("article form")?.textContent,
      ).not.toContain("Authenticate again with Passkey")
      expect(
        Array.from(
          container.querySelectorAll<HTMLInputElement>(
            'article input[type="radio"]',
          ),
        ).map((input) => input.value),
      ).toEqual(["1", "7", "14"])
      container.querySelector<HTMLInputElement>(
        `article input[value="${days}"]`,
      )!.checked = true
      const request = mock(() =>
        Promise.resolve(
          Response.json({
            ...metadata,
            generationId: "new-generation",
            status: "active",
            secret: "replacement-secret",
          }),
        ),
      )
      globalThis.fetch = request as typeof fetch
      await submitManagement()
      expect(request).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            operation: "replace",
            id: metadata.id,
            generationId: metadata.generationId,
            expectedName: metadata.name,
            name: metadata.name,
            lifetimeDays: days,
          }),
        }),
      )
      expect(container.querySelectorAll("article")).toHaveLength(1)
      expect(container.innerHTML).toContain(metadata.id)
      expect(container.textContent).not.toContain("new-generation")
      expect(
        container.querySelector("article")?.getAttribute("data-generation-id"),
      ).toBe("new-generation")
      expect(
        container.querySelector("[data-ph-no-capture][data-rrweb-mask]")
          ?.textContent,
      ).toContain("replacement-secret")
      await act(async () => button("Copy secret").click())
      expect(copy).toHaveBeenCalledWith("replacement-secret")
      await act(async () => button("I have saved it").click())
      expect(container.textContent).not.toContain("replacement-secret")
      expect(
        dom.window.localStorage.length + dom.window.sessionStorage.length,
      ).toBe(0)
    },
  )

  test("keeps replacement editable after a name collision or freshness denial", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[metadata]} />),
    )
    await act(async () => button("Regenerate").click())
    for (const [status, error, message] of [
      [409, "name_conflict", "Choose another name"],
      [403, "issuance_denied", "not permitted"],
    ] as const) {
      globalThis.fetch = mock(() =>
        Promise.resolve(Response.json({ error }, { status })),
      ) as typeof fetch
      await submitManagement()
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        message,
      )
      expect(button("Regenerate secret").disabled).toBe(false)
      expect(container.querySelector("article form")).not.toBeNull()
    }
    container.querySelector<HTMLInputElement>(
      'article input[name="name"]',
    )!.value = "available-name"
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          ...metadata,
          name: "available-name",
          generationId: "new-generation",
          secret: "new-secret",
        }),
      ),
    ) as typeof fetch
    await submitManagement()
    expect(container.querySelector("article h3")?.textContent).toBe(
      "available-name",
    )
    expect(container.textContent).toContain("new-secret")
  })

  test("requires confirmation to revoke and retains the revoked identity without replacement", async () => {
    const request = mock(() =>
      Promise.resolve(
        Response.json({
          ...metadata,
          status: "revoked",
          allowedActions: { rename: true, replace: false, revoke: false },
        }),
      ),
    )
    globalThis.fetch = request as typeof fetch
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[metadata]} />),
    )
    await act(async () => button("Revoke").click())
    expect(container.textContent).toContain(
      "already-accepted work are not cancelled",
    )
    expect(request).not.toHaveBeenCalled()
    await act(async () => button("Cancel").click())
    expect(request).not.toHaveBeenCalled()
    await act(async () => button("Revoke").click())
    await submitManagement()
    expect(container.querySelector("article span")?.textContent).toBe("Revoked")
    expect(container.innerHTML).toContain(metadata.id)
    expect(container.querySelector("article")?.textContent).not.toContain(
      "Regenerate",
    )
  })

  test("stale operations require reload rather than resubmitting the old snapshot", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[metadata]} />),
    )
    await act(async () => button("Rename").click())
    const request = mock(() =>
      Promise.resolve(
        Response.json({ error: "stale_delegation" }, { status: 409 }),
      ),
    )
    globalThis.fetch = request as typeof fetch
    await submitManagement()
    expect(container.textContent).toContain("changed elsewhere")
    expect(button("Save name").disabled).toBe(true)
    expect(button("Reload token list").disabled).toBe(false)
    await submitManagement()
    expect(request).toHaveBeenCalledTimes(1)
    expect(container.querySelector("article h3")?.textContent).toBe(
      metadata.name,
    )
    await act(async () => button("Cancel").click())
    expect(container.textContent).toContain("changed elsewhere")
  })

  test.each([401, "NoAccessTokenError", "JWTVerificationError"] as const)(
    "polling clears a disclosed secret and issuance controls after %s",
    async (failure) => {
      let tick = () => {}
      const timer = spyOn(window, "setInterval").mockImplementation(
        (handler) => {
          if (typeof handler === "function")
            tick = () => {
              handler()
            }
          return 1
        },
      )
      try {
        await act(async () =>
          root.render(<DelegationsClient initialDelegations={[metadata]} />),
        )
        await act(async () => button("Regenerate").click())
        await submitManagement()
        expect(container.textContent).toContain("transient-secret")
        globalThis.fetch = mock(async () => {
          throw new TypeError("offline")
        })
        await act(async () => {
          tick()
        })
        expect(container.textContent).toContain("transient-secret")
        expect(container.textContent).not.toContain(listDefaults.owner.email)
        expect(button("Create secret")).toBeDefined()
        if (typeof failure === "number") {
          globalThis.fetch = mock(
            async () => new Response(null, { status: failure }),
          )
        } else {
          authenticated = false
          sessionErrorTag = failure
        }
        await act(async () => {
          tick()
        })
        expect(container.textContent).toContain("Log in again")
        expect(container.textContent).not.toContain("transient-secret")
        expect(container.textContent).not.toContain(listDefaults.owner.email)
        expect(container.innerHTML).not.toContain(metadata.id)
        expect(container.querySelector("code")).toBeNull()
        expect(container.querySelector("form")).toBeNull()
        expect(button("Create secret")).toBeUndefined()
        expect(button("Authenticate again with Passkey")).toBeUndefined()
      } finally {
        timer.mockRestore()
      }
    },
  )

  test.each(["replacement", "revocation"])(
    "clears a disclosed secret after remote %s and never restores it from metadata",
    async (change) => {
      let tick = () => {}
      const timer = spyOn(window, "setInterval").mockImplementation(
        (handler) => {
          if (typeof handler === "function")
            tick = () => {
              handler()
            }
          return 1
        },
      )
      try {
        await act(async () =>
          root.render(<DelegationsClient initialDelegations={[metadata]} />),
        )
        await act(async () => button("Regenerate").click())
        await submitManagement()
        expect(container.textContent).toContain("transient-secret")
        expect(document.activeElement?.id).toBe("secret-heading")
        globalThis.fetch = mock(() =>
          Promise.resolve(
            Response.json({
              ...listDefaults,
              delegations: [
                {
                  ...metadata,
                  generationId:
                    change === "replacement"
                      ? "remote-generation"
                      : metadata.generationId,
                  status: change === "revocation" ? "revoked" : "active",
                  secret: "never-reveal",
                },
              ],
            }),
          ),
        ) as typeof fetch
        await act(async () => {
          tick()
        })
        expect(container.textContent).not.toContain("transient-secret")
        expect(container.textContent).not.toContain("never-reveal")
        expect(
          container.querySelector('[aria-labelledby="secret-heading"]'),
        ).toBeNull()
        await act(async () => {
          tick()
        })
        expect(
          container.querySelector('[aria-labelledby="secret-heading"]'),
        ).toBeNull()
      } finally {
        timer.mockRestore()
      }
    },
  )

  test.each(["Rename", "Regenerate", "Revoke"])(
    "discards late %s responses after pagehide",
    async (action) => {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[metadata]} />),
      )
      await act(async () => button(action).click())
      const response = Promise.withResolvers<Response>()
      globalThis.fetch = mock(() => response.promise) as typeof fetch
      await submitManagement()
      await act(async () =>
        window.dispatchEvent(new dom.window.Event("pagehide")),
      )
      await act(async () =>
        response.resolve(
          Response.json({
            ...metadata,
            name: "late-name",
            generationId: "late-generation",
            secret: "late-secret",
          }),
        ),
      )
      expect(container.querySelector("article h3")?.textContent).toBe(
        metadata.name,
      )
      expect(container.textContent).not.toContain("late-generation")
      expect(container.textContent).not.toContain("late-secret")
    },
  )

  test.each(["Rename", "Regenerate", "Revoke"])(
    "older polling cannot undo %s",
    async (action) => {
      let tick = () => {}
      const timer = spyOn(window, "setInterval").mockImplementation(
        (handler) => {
          if (typeof handler === "function")
            tick = () => {
              handler()
            }
          return 1
        },
      )
      try {
        await act(async () =>
          root.render(<DelegationsClient initialDelegations={[metadata]} />),
        )
        await act(async () => button(action).click())
        const snapshot = Promise.withResolvers<Response>()
        globalThis.fetch = mock(() => snapshot.promise) as typeof fetch
        await act(async () => {
          tick()
        })
        globalThis.fetch = mock(() =>
          Promise.resolve(
            Response.json({
              ...metadata,
              name: "winning-name",
              secret: "winning-secret",
            }),
          ),
        ) as typeof fetch
        await submitManagement()
        await act(async () =>
          snapshot.resolve(
            Response.json({
              ...listDefaults,
              delegations: [metadata],
            }),
          ),
        )
        expect(container.querySelector("article h3")?.textContent).toBe(
          "winning-name",
        )
        expect(container.textContent?.includes("winning-secret")).toBe(
          action === "Regenerate",
        )
      } finally {
        timer.mockRestore()
      }
    },
  )

  test("shows expired identities and never-used metadata with exactly three lifetimes", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[metadata]} />),
    )
    expect(container.textContent).toContain("Expired")
    expect(container.textContent).toContain("Never used")
    expect(container.textContent).not.toContain(metadata.expiresAt)
    expect(container.querySelector("article")?.textContent).toContain(
      "Jan 2, 2020, 12:00 AM UTC",
    )
    expect(container.innerHTML).toContain(metadata.id)
    expect(container.textContent).not.toContain(metadata.generationId)
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).map((input) => input.value),
    ).toEqual(["1", "7", "14"])
  })

  test.each([0, 4_102_444_800_000])(
    "uses server status with browser clock at %i",
    async (now) => {
      const clock = spyOn(Date, "now").mockReturnValue(now)
      try {
        await act(async () =>
          root.render(
            <DelegationsClient
              initialDelegations={[
                metadata,
                { ...metadata, id: "active-token", status: "active" },
                {
                  ...metadata,
                  id: "revoked-token",
                  status: "revoked",
                  revokedAt: metadata.createdAt,
                },
              ]}
            />,
          ),
        )
        expect(
          Array.from(container.querySelectorAll("article span")).map(
            (node) => node.textContent,
          ),
        ).toEqual(["Expired", "Active", "Revoked"])
      } finally {
        clock.mockRestore()
      }
    },
  )

  test("refreshes expiry from the server without losing metadata or the one-time secret", async () => {
    let tick = () => {}
    const timer = spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function")
        tick = () => {
          handler()
        }
      return 1
    })
    try {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...metadata,
            status: "active",
            secret: "transient-secret",
          }),
        ),
      ) as typeof fetch
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[]} />),
      )
      container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
        "invoice-agent"
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          )
      })
      expect(container.querySelector("article span")?.textContent).toBe(
        "Active",
      )
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("offline")),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      expect(container.querySelector("article span")?.textContent).toBe(
        "Active",
      )
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [metadata],
          }),
        ),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      expect(container.querySelector("article span")?.textContent).toBe(
        "Expired",
      )
      expect(container.innerHTML).toContain(metadata.id)
      expect(container.textContent).toContain("Never used")
      expect(container.textContent).toContain("transient-secret")
      await act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "I have saved it")!
          .click()
      })
      globalThis.fetch = mock(() =>
        Promise.resolve(Response.json({ ...listDefaults, delegations: [] })),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      expect(container.innerHTML).not.toContain(metadata.id)
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [
              {
                ...metadata,
                id: "external-token",
                secret: "must-not-resurrect",
              },
            ],
          }),
        ),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      expect(container.innerHTML).toContain("external-token")
      expect(container.textContent).not.toContain("transient-secret")
      expect(container.textContent).not.toContain("must-not-resurrect")
      expect(
        container.querySelector('[aria-labelledby="secret-heading"]'),
      ).toBeNull()
    } finally {
      timer.mockRestore()
    }
  })

  test("guards overlapping metadata, then accepts the next list", async () => {
    let tick = () => {}
    const timer = spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function")
        tick = () => {
          handler()
        }
      return 1
    })
    try {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[]} />),
      )
      const snapshot = Promise.withResolvers<Response>()
      globalThis.fetch = mock(() => snapshot.promise) as typeof fetch
      await act(async () => {
        tick()
      })
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({ ...metadata, secret: "transient-secret" }),
        ),
      ) as typeof fetch
      container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
        "invoice-agent"
      await act(async () => {
        container.querySelector("form")!.dispatchEvent(
          new dom.window.Event("submit", {
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      await act(async () => {
        snapshot.resolve(Response.json({ ...listDefaults, delegations: [] }))
      })
      expect(container.innerHTML).toContain(metadata.id)
      expect(container.querySelector("form")).not.toBeNull()
      expect(
        container.textContent?.includes("Authenticate again with Passkey"),
      ).toBe(false)
      expect(container.textContent).toContain("transient-secret")
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [{ ...metadata, id: "other-tab-token" }],
          }),
        ),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      expect(container.innerHTML).not.toContain(metadata.id)
      expect(container.innerHTML).toContain("other-tab-token")
      expect(container.querySelectorAll("article")).toHaveLength(1)
      expect(container.textContent).not.toContain("transient-secret")
      expect(container.querySelector("form")).not.toBeNull()
      expect(container.textContent).not.toContain(
        "Authenticate again with Passkey",
      )
    } finally {
      timer.mockRestore()
    }
  })

  test("failed polling retains the last authorized metadata", async () => {
    let tick = () => {}
    const timer = spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function")
        tick = () => {
          handler()
        }
      return 1
    })
    try {
      await act(async () =>
        root.render(<DelegationsClient initialDelegations={[metadata]} />),
      )
      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({
            ...listDefaults,
            delegations: [metadata],
          }),
        ),
      ) as typeof fetch
      await act(async () => {
        tick()
      })
      for (const failure of [
        () => Promise.reject(new Error("offline")),
        () =>
          Promise.resolve(
            Response.json({ error: "unavailable" }, { status: 500 }),
          ),
        () => Promise.resolve(Response.json({ delegations: [] })),
      ]) {
        globalThis.fetch = mock(failure) as typeof fetch
        await act(async () => {
          tick()
        })
        expect(container.querySelector("form")).not.toBeNull()
        expect(
          container.textContent?.includes("Authenticate again with Passkey"),
        ).toBe(false)
        expect(container.innerHTML).toContain(metadata.id)
      }
    } finally {
      timer.mockRestore()
    }
  })

  test("discloses once and retains issuance without a permanent authentication panel", async () => {
    await act(async () =>
      root.render(<DelegationsClient initialDelegations={[]} />),
    )
    expect(container.querySelector("#reauth-heading")).toBeNull()
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false)
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
      "invoice-agent"
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    )
    expect(container.textContent).toContain("transient-secret")
    const button = (text: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent === text,
      )!
    await act(async () => button("Copy secret").click())
    expect(copy).toHaveBeenCalledWith("transient-secret")
    expect(container.textContent).toContain("Secret copied.")
    await act(async () => button("I have saved it").click())
    expect(container.textContent).not.toContain("transient-secret")
    expect(container.innerHTML).toContain(metadata.id)
    expect(dom.window.localStorage.length).toBe(0)
    expect(dom.window.sessionStorage.length).toBe(0)
  })

  test.each(["before response", "after response"])(
    "does not disclose an earlier Activity lifecycle's secret when returning %s",
    async (returnTiming) => {
      const response = Promise.withResolvers<Response>()
      const request = mock(() => response.promise)
      globalThis.fetch = request as typeof fetch
      const renderActivity = async (mode: "visible" | "hidden") => {
        await act(async () => {
          root.render(
            <Activity mode={mode}>
              <DelegationsClient initialDelegations={[]} />
            </Activity>,
          )
        })
      }

      await renderActivity("visible")
      const name =
        container.querySelector<HTMLInputElement>('input[name="name"]')!
      name.value = "invoice-agent"
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          )
      })
      expect(request).toHaveBeenCalledTimes(1)
      await renderActivity("hidden")
      if (returnTiming === "before response") await renderActivity("visible")
      await act(async () => {
        response.resolve(Response.json({ ...metadata, secret: "late-secret" }))
      })
      if (returnTiming === "after response") await renderActivity("visible")

      // Activity preserves this component and its DOM rather than remounting it.
      expect(container.querySelector('input[name="name"]')).toBe(name)
      expect(container.textContent).not.toContain("late-secret")
      expect(
        container.querySelector('[aria-labelledby="secret-heading"]'),
      ).toBeNull()
      expect(copy).not.toHaveBeenCalled()

      globalThis.fetch = mock(() =>
        Promise.resolve(
          Response.json({ ...metadata, secret: "current-secret" }),
        ),
      ) as typeof fetch
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          )
      })
      expect(container.textContent).toContain("current-secret")
    },
  )
})
