import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

mock.module("server-only", () => ({}))

const {
  expiredGoogleIdentity,
  readGoogleAttempt,
  sealGoogleAttempt,
  sealGoogleIdentity,
} = await import("../lib/auth/google-revalidation")

const now = 1_800_000_000_000
const originalCredential = process.env["FRONTEND_JWT_TOKEN"]
let clock: ReturnType<typeof spyOn<typeof Date, "now">>

beforeEach(() => {
  process.env["FRONTEND_JWT_TOKEN"] = "test-dashboard-credential"
  clock = spyOn(Date, "now").mockReturnValue(now)
})

afterEach(() => {
  clock.mockRestore()
  if (originalCredential === undefined) {
    delete process.env["FRONTEND_JWT_TOKEN"]
  } else {
    process.env["FRONTEND_JWT_TOKEN"] = originalCredential
  }
})

test("prior Google identity can start revalidation only at or after its SSO deadline", () => {
  const identity = sealGoogleIdentity({
    subject: "google-user",
    expiresAt: now,
  })
  clock.mockReturnValue(now - 1)
  expect(expiredGoogleIdentity(identity)).toBeUndefined()
  clock.mockReturnValue(now)
  expect(expiredGoogleIdentity(identity)).toMatchObject({
    subject: "google-user",
  })
})

test("only a fresh, untampered Google attempt can supply callback context", () => {
  const context = {
    subject: "google-user",
    state: "oauth-state",
    destination: "/processes?view=all",
  }
  const attempt = sealGoogleAttempt(context)
  expect(readGoogleAttempt(attempt)).toMatchObject(context)
  const signatureStart = attempt.lastIndexOf(".") + 1
  const replacement = attempt[signatureStart] === "A" ? "B" : "A"
  const tampered = `${attempt.slice(0, signatureStart)}${replacement}${attempt.slice(signatureStart + 1)}`
  expect(readGoogleAttempt(tampered)).toBeNull()
  expect(readGoogleAttempt(`${attempt}.extra`)).toBeNull()
  clock.mockReturnValue(now + 600_000)
  expect(readGoogleAttempt(attempt)).toBeNull()
})
