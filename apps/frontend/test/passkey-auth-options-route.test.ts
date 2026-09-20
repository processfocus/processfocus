import { POST } from "../app/api/auth/passkey/auth-options/route"
import { afterEach, describe, expect, mock, test } from "bun:test"

const originalFetch = globalThis.fetch

describe("passkey auth-options route", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("always requests usernameless authentication options", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ challengeId: "challenge", options: {} })),
    )
    globalThis.fetch = fetchMock as typeof fetch
    const response = await POST(
      new Request("https://console.example.com/api/auth/passkey/auth-options", {
        method: "POST",
        body: JSON.stringify({ email: "ignored@example.com" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/oauth/passkey/auth-options"),
      expect.objectContaining({ body: "{}", method: "POST" }),
    )
  })
})
