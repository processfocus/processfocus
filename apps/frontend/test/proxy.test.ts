import { beforeEach, describe, expect, test, vi } from "vitest"
import { mock } from "bun:test"

mock.module("server-only", () => ({}))

import { NextRequest } from "next/server"
import * as authClient from "../lib/auth/client"
import { isPublicPath } from "../lib/auth/config"

const { proxy } = await import("../proxy")

function createRequest(
  path: string,
  cookies: Record<string, string> = {},
): Request {
  const url = new URL(`https://example.com${path}`)
  const headers = new Headers({ host: "example.com" })

  return {
    url: url.toString(),
    headers,
    nextUrl: {
      pathname: url.pathname,
      search: url.search,
      searchParams: url.searchParams,
    },
    cookies: {
      get(name: string) {
        const value = cookies[name]
        return value === undefined ? undefined : { value }
      },
    },
  } as unknown as Request
}

describe("proxy", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test.each(["GET", "POST"])(
    "lets protected cli-auth own stale-session handling on %s",
    async (method) => {
      const getAuthClientSpy = vi
        .spyOn(authClient, "getAuthClient")
        .mockImplementation(() => {
          throw new Error("proxy must not verify or rotate CLI sessions")
        })
      const request = new NextRequest(
        "https://example.com/cli-auth?port=3210&state=nonce",
        {
          method,
          headers: {
            host: "example.com",
            cookie: "access_token=revoked; refresh_token=replaced",
          },
        },
      )
      expect(isPublicPath("/cli-auth")).toBe(false)
      const response = await proxy(request)
      expect(response.status).toBe(200)
      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(getAuthClientSpy).not.toHaveBeenCalled()
    },
  )

  test("passes fresh unauthenticated CLI login to the protected handler", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/cli-auth?port=3210&state=nonce"),
    )
    expect(response.headers.get("location")).toBeNull()
    expect(response.status).toBe(200)
  })

  test("does not exempt neighboring protected paths", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/cli-auth/other"),
    )
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/login",
    )
  })

  test("redirects denied Server Actions through the action protocol, not fetch", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/act-on-behalf?ownerUserId=other", {
        method: "POST",
        headers: { "next-action": "list-delegations" },
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-action-redirect")).toBe(
      "https://example.com/login?redirect=%2Fact-on-behalf%3FownerUserId%3Dother;replace",
    )
    expect(await response.text()).toBe("")
  })

  test.each(["GET", "POST"])(
    "keeps ordinary %s login redirects without an action header",
    async (method) => {
      const response = await proxy(
        new NextRequest("https://example.com/act-on-behalf", { method }),
      )
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe(
        "https://example.com/login?redirect=%2Fact-on-behalf",
      )
      expect(response.headers.get("x-action-redirect")).toBeNull()
    },
  )

  test("does not initialize the auth client for /login without cookies", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const response = await proxy(createRequest("/login"))

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  test("allows public todo pages without initializing the auth client", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const response = await proxy(createRequest("/public/form/public-token"))

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  test("allows invitation passkey registration without initializing the auth client", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const response = await proxy(createRequest("/register/passkey"))

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  test("allows public todo api routes without initializing the auth client", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const response = await proxy(createRequest("/api/public/to-dos/complete"))

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  test("allows public frontend manifest assets without initializing the auth client", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const manifestResponse = await proxy(createRequest("/manifest.webmanifest"))
    const iconResponse = await proxy(
      createRequest("/_pf/app-icons/favicon-1234567890abcdef.ico"),
    )

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(manifestResponse.status).toBe(200)
    expect(manifestResponse.headers.get("location")).toBeNull()
    expect(iconResponse.status).toBe(200)
    expect(iconResponse.headers.get("location")).toBeNull()
  })

  test("allows the frontend boot health surface without a session", async () => {
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw new Error("should not be called")
      })

    const response = await proxy(createRequest("/_pf/health"))

    expect(getAuthClientSpy).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  test("allows /login to render when auth client initialization fails", async () => {
    const error = new Error("bad frontend jwt")
    const getAuthClientSpy = vi
      .spyOn(authClient, "getAuthClient")
      .mockImplementation(() => {
        throw error
      })
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)

    const response = await proxy(
      createRequest("/login", { refresh_token: "refresh-token" }),
    )

    expect(getAuthClientSpy).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      "[proxy] Auth client initialization failed for /login; allowing public page render",
      error,
    )
  })
})
