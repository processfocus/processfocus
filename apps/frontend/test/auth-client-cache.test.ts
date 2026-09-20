import { afterEach, expect, mock, spyOn, test } from "bun:test"

const jwtFor = (clientId: string) =>
  `header.${Buffer.from(
    JSON.stringify({ properties: { clientId }, aud: "dashboard" }),
  ).toString("base64url")}.signature`

let config = { jwt: jwtFor("frontend"), issuer: "https://auth.example.test" }
mock.module("../lib/auth/issuer", () => ({
  getFrontendAuthClientConfig: () => config,
  getIssuerUrl: () => config.issuer,
  validateFrontendJwtIssuer: () => undefined,
}))

const { getAuthClient } = await import("../lib/auth/client")

afterEach(() => mock.restore())

test("auth clients expire after ten minutes and are invalidated by JWT or issuer changes", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_000)
  const initial = getAuthClient()
  expect(getAuthClient()).toBe(initial)

  clock.mockReturnValue(600_999)
  expect(getAuthClient()).toBe(initial)
  clock.mockReturnValue(601_000)
  const renewed = getAuthClient()
  expect(renewed).not.toBe(initial)

  config = { ...config, jwt: jwtFor("another-frontend") }
  const changedJwt = getAuthClient()
  expect(changedJwt).not.toBe(renewed)
  expect(getAuthClient()).toBe(changedJwt)

  config = { ...config, issuer: "https://another-auth.example.test" }
  const changedIssuer = getAuthClient()
  expect(changedIssuer).not.toBe(changedJwt)
  expect(getAuthClient()).toBe(changedIssuer)
})
