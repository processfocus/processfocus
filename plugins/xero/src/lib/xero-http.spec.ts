import { parseRetryAfterSeconds } from "./xero-http"
import { describe, expect, it } from "bun:test"

describe("Xero Retry-After parsing", () => {
  it("uses a one-second minimum so retries cannot tight-loop", () => {
    expect(parseRetryAfterSeconds(undefined, 0)).toBe(1)
    expect(parseRetryAfterSeconds("0", 0)).toBe(1)
    expect(parseRetryAfterSeconds("", 0)).toBe(1)
  })

  it("honours numeric Retry-After seconds up to the cap", () => {
    expect(parseRetryAfterSeconds("2", 0)).toBe(2)
    expect(parseRetryAfterSeconds("60", 0)).toBe(60)
    expect(parseRetryAfterSeconds("120", 0)).toBe(60)
  })

  it("converts HTTP-date Retry-After values", () => {
    expect(
      parseRetryAfterSeconds(
        "Wed, 21 Oct 2015 07:28:05 GMT",
        Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"),
      ),
    ).toBe(5)
  })
})
