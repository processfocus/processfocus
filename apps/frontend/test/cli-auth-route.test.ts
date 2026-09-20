import type { getAuthClient } from "../lib/auth/client"
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

mock.module("server-only", () => ({}))

type RefreshResult = Awaited<
  ReturnType<ReturnType<typeof getAuthClient>["refresh"]>
>

let refreshToken: string | undefined
let refreshResult: RefreshResult
let delegated = false
let valid = true
let live = true
const cookieValues = new Map<string, string>()
const refresh = mock(async () => refreshResult)
const setCookie = mock((name: string, value: string) => {
  cookieValues.set(name, value)
})
const acceptSession = mock(async () => (live ? {} : null))
mock.module("@/lib/auth/ssr-session", () => ({
  acceptVerifiedSession: acceptSession,
}))

mock.module("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      const value =
        cookieValues.get(name) ??
        (name === "refresh_token" || name === "access_token"
          ? refreshToken
          : undefined)
      return value ? { value } : undefined
    },
    set: setCookie,
  }),
  headers: () => new Headers({ host: "org.example.test" }),
}))

mock.module("@/lib/auth/client", () => ({
  getAuthClient: () => ({
    refresh,
    verify: async () => ({
      err: !valid,
      subject: {
        properties: delegated
          ? { delegation: { id: "delegate" } }
          : { email: "owner@example.test" },
      },
    }),
  }),
}))

const handoffUrl = "https://org.example.test/cli-auth?port=3210&state=nonce"
async function confirmationForm() {
  const { GET } = await import("../app/cli-auth/route")
  const response = await GET(new Request(handoffUrl))
  const html = await response.text()
  const confirmation = /name="confirmation" value="([^"]+)"/.exec(html)?.[1]
  expect(confirmation).toBeDefined()
  return new URLSearchParams({ confirmation: confirmation ?? "" })
}
function postRequest(
  body: URLSearchParams,
  url = handoffUrl,
  origin = "https://org.example.test",
) {
  return new Request(url, {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin" },
    body,
  })
}

describe("GET /cli-auth", () => {
  beforeEach(() => {
    refreshToken = undefined
    refreshResult = { err: false }
    delegated = false
    valid = true
    live = true
    cookieValues.clear()
    acceptSession.mockClear()
    refresh.mockClear()
    setCookie.mockClear()
  })

  test("exports delegated access with the issuer's remaining lifetime", async () => {
    refreshToken = "refresh-token"
    delegated = true
    refreshResult = {
      err: false,
      tokens: { access: "delegated-access", expiresIn: 1 },
    }
    const { POST } = await import("../app/cli-auth/route")
    const response = await POST(postRequest(await confirmationForm()))
    const callback = new URL(response.headers.get("location") ?? "")
    expect(callback.searchParams.get("access_token")).toBe("delegated-access")
    expect(callback.searchParams.get("expires_in")).toBe("1")
    expect(callback.searchParams.get("state")).toBe("nonce")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(refresh).toHaveBeenCalledWith("refresh-token", { scope: "cli" })
    expect(setCookie).toHaveBeenCalledWith(
      expect.any(String),
      "delegated-access",
      expect.objectContaining({ maxAge: 1 }),
    )
  })

  test("fails delegated handoff without publishing cookies or credentials", async () => {
    refreshToken = "refresh-token"
    delegated = true
    const { POST } = await import("../app/cli-auth/route")
    const response = await POST(postRequest(await confirmationForm()))
    const callback = new URL(response.headers.get("location") ?? "")
    expect(callback.searchParams.get("error")).toBe("failed")
    expect(callback.searchParams.get("state")).toBe("nonce")
    expect(callback.searchParams.has("access_token")).toBe(false)
    expect(
      setCookie.mock.calls.every(([name]) => name.includes("cli_confirmation")),
    ).toBe(true)
  })

  test("malicious top-level GET only presents protected confirmation, never rotates or exports", async () => {
    refreshToken = "refresh-token"
    delegated = true
    const { GET } = await import("../app/cli-auth/route")
    const response = await GET(
      new Request(handoffUrl, {
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("same-origin")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    )
    const html = await response.text()
    expect(html).toContain("Allow CLI access")
    expect(html).not.toContain("refresh-token")
    expect(refresh).not.toHaveBeenCalled()
  })

  test("Next's implicit HEAD handler cannot bypass confirmation", async () => {
    refreshToken = "refresh-token"
    delegated = true
    const { GET } = await import("../app/cli-auth/route")
    const response = await GET(new Request(handoffUrl, { method: "HEAD" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  test.each([
    "missing",
    "forged",
    "nonce",
    "port",
    "state",
    "session",
    "origin",
    "missing-origin",
    "content-type",
    "fetch-site",
    "cookie",
    "expired",
  ])("rejects %s confirmation without refresh/export", async (attack) => {
    refreshToken = "refresh-token"
    delegated = true
    const form = await confirmationForm()
    let url = handoffUrl
    if (attack === "missing") form.delete("confirmation")
    if (attack === "forged") form.set("confirmation", "forged")
    if (attack === "nonce" || attack === "cookie" || attack === "expired") {
      const original = form.get("confirmation") ?? ""
      const forged =
        attack === "expired"
          ? original.replace(/^\d+/, "1")
          : original.replace(/\.([a-f0-9])/, (_, digit) =>
              digit === "0" ? ".1" : ".0",
            )
      form.set("confirmation", forged)
      if (attack !== "nonce") {
        for (const name of cookieValues.keys()) cookieValues.set(name, forged)
      }
    }
    if (attack === "port") url = url.replace("3210", "4321")
    if (attack === "state") url = url.replace("state=nonce", "state=attacker")
    if (attack === "session") refreshToken = "another-session"
    const request = postRequest(
      form,
      url,
      attack === "origin" ? "https://evil.test" : undefined,
    )
    if (attack === "fetch-site")
      request.headers.set("sec-fetch-site", "cross-site")
    if (attack === "missing-origin") request.headers.delete("origin")
    if (attack === "content-type")
      request.headers.set("content-type", "text/plain")
    setCookie.mockClear()
    const { POST } = await import("../app/cli-auth/route")
    const response = await POST(request)
    if (
      ["origin", "missing-origin", "content-type", "fetch-site"].includes(
        attack,
      )
    ) {
      expect(response.status).toBe(403)
      expect(response.headers.get("location")).toBeNull()
    } else {
      expect(response.status).toBe(303)
      const callback = new URL(response.headers.get("location") ?? "")
      expect(callback.origin).toBe(
        `http://localhost:${new URL(url).searchParams.get("port")}`,
      )
      expect(callback.searchParams.get("state")).toBe(
        new URL(url).searchParams.get("state"),
      )
      expect([...callback.searchParams.keys()].sort()).toEqual([
        "error",
        "state",
      ])
      expect(callback.searchParams.get("error")).toBe("failed")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    }
    expect(refresh).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })

  test("consumes browser confirmation so a repeated POST cannot export again", async () => {
    refreshToken = "refresh-token"
    delegated = true
    refreshResult = {
      err: false,
      tokens: { access: "exported", expiresIn: 60 },
    }
    const form = await confirmationForm()
    const { POST } = await import("../app/cli-auth/route")
    expect((await POST(postRequest(form))).status).toBe(303)
    const replay = await POST(postRequest(form))
    expect(replay.status).toBe(303)
    expect(
      new URL(replay.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("failed")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each(["access_token", "refresh_token", "both"])(
    "finishes expired handoff when %s disappears between confirmation GET and POST",
    async (missing) => {
      refreshToken = "refresh-token"
      delegated = true
      const form = await confirmationForm()
      if (missing === "both") refreshToken = undefined
      else cookieValues.set(missing, "")
      setCookie.mockClear()
      acceptSession.mockClear()
      const { POST } = await import("../app/cli-auth/route")
      const response = await POST(postRequest(form))
      expect(response.status).toBe(303)
      expect(response.headers.get("location")).toBe(
        "http://localhost:3210/callback?state=nonce&error=expired",
      )
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(refresh).not.toHaveBeenCalled()
      expect(acceptSession).not.toHaveBeenCalled()
      expect(setCookie).not.toHaveBeenCalled()
    },
  )

  test.each([false, true])(
    "finishes an expired nonce handoff with confirmation cookie removed=%s",
    async (removed) => {
      refreshToken = "refresh-token"
      delegated = true
      const form = await confirmationForm()
      const deadline = Number(form.get("confirmation")?.split(".")[0])
      if (removed) cookieValues.clear()
      setCookie.mockClear()
      acceptSession.mockClear()
      const now = spyOn(Date, "now").mockReturnValue(deadline)
      try {
        const { POST } = await import("../app/cli-auth/route")
        const response = await POST(postRequest(form))
        expect(response.status).toBe(303)
        expect(response.headers.get("location")).toBe(
          `http://localhost:3210/callback?state=nonce&error=${removed ? "failed" : "expired"}`,
        )
        expect(response.headers.get("referrer-policy")).toBe("no-referrer")
        expect(refresh).not.toHaveBeenCalled()
        expect(acceptSession).not.toHaveBeenCalled()
        expect(setCookie).not.toHaveBeenCalled()
      } finally {
        now.mockRestore()
      }
    },
  )

  test.each([
    "invalid",
    "revoked",
    "replaced",
    "missing-access",
    "missing-refresh",
  ])(
    "existing %s session returns a token-free state-preserving callback",
    async (failure) => {
      refreshToken = "refresh-token"
      delegated = true
      if (failure === "invalid") valid = false
      if (failure === "revoked" || failure === "replaced") live = false
      if (failure === "missing-access") cookieValues.set("access_token", "")
      if (failure === "missing-refresh") cookieValues.set("refresh_token", "")
      const { GET } = await import("../app/cli-auth/route")
      const response = await GET(new Request(handoffUrl))
      const callback = new URL(response.headers.get("location") ?? "")
      expect(callback.origin).toBe("http://localhost:3210")
      expect(callback.searchParams.get("state")).toBe("nonce")
      expect(callback.searchParams.get("error")).toBe(
        failure.startsWith("missing") || failure === "invalid"
          ? "expired"
          : "failed",
      )
      expect(callback.searchParams.has("access_token")).toBe(false)
      if (failure === "invalid" || failure === "missing-access") {
        expect(refresh).toHaveBeenCalledWith("refresh-token")
      } else expect(refresh).not.toHaveBeenCalled()
      expect(setCookie).not.toHaveBeenCalled()
    },
  )

  test("rechecks live validity after confirmation and before refresh", async () => {
    refreshToken = "refresh-token"
    delegated = true
    const form = await confirmationForm()
    live = false
    const { POST } = await import("../app/cli-auth/route")
    const response = await POST(postRequest(form))
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("failed")
    expect(acceptSession).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
  })

  test.each([false, true])(
    "recovers an expired access cookie without bypassing delegated=%s confirmation",
    async (isDelegated) => {
      refreshToken = "refresh-token"
      delegated = isDelegated
      cookieValues.set("access_token", "")
      refreshResult = {
        err: false,
        tokens: {
          access: "recovered-access",
          refresh: "recovered-refresh",
          expiresIn: 60,
        },
      }
      const { GET, POST } = await import("../app/cli-auth/route")
      const response = await GET(new Request(handoffUrl))
      expect(refresh).toHaveBeenNthCalledWith(1, "refresh-token")
      if (isDelegated) {
        expect(response.status).toBe(200)
        expect(refresh).toHaveBeenCalledTimes(1)
        const confirmation =
          /name="confirmation" value="([^"]+)"/.exec(
            await response.text(),
          )?.[1] ?? ""
        expect(
          (await POST(postRequest(new URLSearchParams({ confirmation }))))
            .status,
        ).toBe(303)
      } else expect(response.status).toBe(307)
      expect(refresh).toHaveBeenLastCalledWith("recovered-refresh", {
        scope: "cli",
      })
    },
  )

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unusable lifetime %s before installing cookies",
    async (expiresIn) => {
      refreshToken = "refresh-token"
      refreshResult = {
        err: false,
        tokens: { access: "expired-access", expiresIn },
      }
      const { GET } = await import("../app/cli-auth/route")
      const response = await GET(
        new Request("https://org.example.test/cli-auth?port=3210&state=nonce"),
      )
      const callback = new URL(response.headers.get("location") ?? "")
      expect(callback.searchParams.get("error")).toBe("expired")
      expect(callback.searchParams.get("state")).toBe("nonce")
      expect(callback.searchParams.has("access_token")).toBe(false)
      expect(setCookie).not.toHaveBeenCalled()
    },
  )

  test("preserves callback state while sending a user through login", async () => {
    const { GET } = await import("../app/cli-auth/route")

    const response = await GET(
      new Request(
        "https://org.example.test/cli-auth?port=3210&state=nonce-123",
      ),
    )

    const loginUrl = new URL(response.headers.get("location") ?? "")
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe(
      "https://org.example.test/login",
    )
    expect(loginUrl.searchParams.get("redirect")).toBe(
      "/cli-auth?port=3210&state=nonce-123",
    )
  })

  test("preserves callback state after an authenticated refresh", async () => {
    refreshToken = "refresh-token"
    refreshResult = {
      err: false,
      tokens: {
        access: "access-token",
        expiresIn: 60,
      },
    }
    const { GET } = await import("../app/cli-auth/route")

    const response = await GET(
      new Request(
        "https://org.example.test/cli-auth?port=4321&state=nonce-456",
      ),
    )

    const callbackUrl = new URL(response.headers.get("location") ?? "")
    expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(
      "http://localhost:4321/callback",
    )
    expect(callbackUrl.searchParams.get("access_token")).toBe("access-token")
    expect(callbackUrl.searchParams.get("expires_in")).toBe("60")
    expect(callbackUrl.searchParams.get("state")).toBe("nonce-456")
  })
})
