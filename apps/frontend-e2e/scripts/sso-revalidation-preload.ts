import { mock } from "bun:test"

// Only the expiry journey accelerates time; the SSO-only journey uses real policy.
mock.module("../../../packages/auth-api/src/lib/sso-policy.ts", () => ({
  SSO_REVALIDATION_INTERVAL_MS: 60_000,
}))
