import { passkeyOriginOverride } from "./passkey-origin"
import { expect, test } from "bun:test"

test("hosted imports retain the issuer even with a separate frontend link base", () => {
  expect(
    passkeyOriginOverride({
      OAUTH_ISSUER_URL: "https://auth.example.com",
      FRONTEND_BASE_URL: "https://dashboard.example.com",
    }),
  ).toEqual({ rpID: "auth.example.com", origin: "https://auth.example.com" })
})

test("the local launcher can select the Dashboard WebAuthn origin", () => {
  expect(
    passkeyOriginOverride({
      OAUTH_ISSUER_URL: "http://localhost:4020",
      PF_LOCAL_FRONTEND_ORIGIN: "http://localhost:3000",
    }),
  ).toEqual({ rpID: "localhost", origin: "http://localhost:3000" })
})

test("frontend link configuration alone preserves the authored passkey config", () => {
  expect(
    passkeyOriginOverride({
      FRONTEND_BASE_URL: "https://dashboard.example.com",
    }),
  ).toBeUndefined()
})
