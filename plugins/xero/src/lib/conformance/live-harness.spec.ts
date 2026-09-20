import { classifyAccountingObservationFailure } from "./live-harness"
import { describe, expect, it } from "bun:test"

describe("Xero Demo Company observation failure classification", () => {
  it("classifies 401, 403, 429, and 5xx like the live adapter", () => {
    expect(classifyAccountingObservationFailure(401, undefined, 0).code).toBe(
      "auth",
    )
    expect(
      classifyAccountingObservationFailure(401, undefined, 0).retryable,
    ).toBe(false)
    expect(classifyAccountingObservationFailure(403, undefined, 0).code).toBe(
      "permission",
    )
    expect(
      classifyAccountingObservationFailure(403, undefined, 0).retryable,
    ).toBe(false)

    const rateLimited = classifyAccountingObservationFailure(429, "8", 0)
    expect(rateLimited.code).toBe("rate_limit")
    expect(rateLimited.retryable).toBe(true)
    expect(rateLimited.retryAfterSeconds).toBe(8)

    const server = classifyAccountingObservationFailure(503, undefined, 0)
    expect(server.code).toBe("provider_server")
    expect(server.retryable).toBe(true)
  })

  it("keeps other observation failures as malformed responses", () => {
    const failed = classifyAccountingObservationFailure(404, undefined, 0)
    expect(failed.code).toBe("malformed_response")
    expect(failed.retryable).toBe(false)
  })
})
