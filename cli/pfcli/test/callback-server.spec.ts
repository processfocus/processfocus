import { Effect } from "effect"
import { startCallbackServer } from "../src/commands/auth/callback-server"
import { signedAuthToken } from "./auth-token-fixture"
import { describe, expect, it } from "bun:test"

describe("actual localhost login callback", () => {
  it.each([28800, 0.25])(
    "preserves successful credentials with %s seconds remaining",
    async (expiresIn) => {
      const server = Effect.runSync(startCallbackServer)
      try {
        const accessToken = signedAuthToken(Date.now() + 28801_000)
        const before = Date.now()
        const params = new URLSearchParams({
          state: server.state,
          access_token: accessToken,
          expires_in: String(expiresIn),
        })
        const response = await fetch(
          `http://localhost:${server.port}/callback?${params}`,
        )
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(await response.text()).not.toContain(accessToken)
        const tokens = await server.tokens
        expect(tokens.accessToken).toBe(accessToken)
        expect(tokens.expiresAt).toBeGreaterThanOrEqual(
          before + expiresIn * 1000,
        )
        expect(tokens.expiresAt).toBeLessThanOrEqual(
          Date.now() + expiresIn * 1000,
        )
        expect(
          (await fetch(`http://localhost:${server.port}/callback?${params}`))
            .status,
        ).toBe(409)
      } finally {
        server.stop()
      }
    },
  )

  it.each([
    ["error=failed", "Login failed"],
    ["error=expired", "Login expired"],
    [
      "error=secret-value&error_description=secret-value&access_token=secret-value&expires_in=60",
      "Login failed",
    ],
    ["expires_in=60", "Missing access token"],
    [
      "access_token=secret-value&expires_in=60",
      "Invalid login credential expiry",
    ],
    ...[{}, { exp: "1800000000" }, { exp: null }, { exp: 1e300 }].map(
      (payload) => [
        `access_token=header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature&expires_in=60`,
        "Invalid login credential expiry",
      ],
    ),
    ...["", "0", "-1", "NaN", "Infinity", "1e300", "1e-300", "garbage"].map(
      (value) => [
        `access_token=secret-value&expires_in=${value}`,
        "Invalid login credential lifetime",
      ],
    ),
    ["access_token=secret-value", "Invalid login credential lifetime"],
  ])("rejects %s without reflecting secrets", async (query, message) => {
    const server = Effect.runSync(startCallbackServer)
    try {
      const response = await fetch(
        `http://localhost:${server.port}/callback?state=${server.state}&${query}`,
      )
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain("secret-value")
      await expect(server.tokens).rejects.toThrow(message)
      expect(
        (
          await fetch(
            `http://localhost:${server.port}/callback?state=${server.state}&access_token=token&expires_in=60`,
          )
        ).status,
      ).toBe(409)
    } finally {
      server.stop()
    }
  })

  it.each(["", "wrong-state"])(
    "validates state before processing failures (%s)",
    async (state) => {
      const server = Effect.runSync(startCallbackServer)
      try {
        const response = await fetch(
          `http://localhost:${server.port}/callback?state=${state}&error=expired`,
        )
        expect(response.status).toBe(400)
        await expect(server.tokens).rejects.toThrow(
          "Invalid login callback state",
        )
      } finally {
        server.stop()
      }
    },
  )
})
