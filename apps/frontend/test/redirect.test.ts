import { describe, expect, test } from "vitest"
import { getValidRedirect, validateRedirect } from "../lib/auth/redirect"

describe("validateRedirect", () => {
  // Valid redirects
  test("accepts valid relative paths", () => {
    expect(validateRedirect("/to-dos").url).toBe("/to-dos")
    expect(validateRedirect("/to-dos?filter=urgent").url).toBe(
      "/to-dos?filter=urgent",
    )
    expect(validateRedirect("/dashboard/settings").url).toBe(
      "/dashboard/settings",
    )
  })

  test("accepts root path", () => {
    expect(validateRedirect("/").url).toBe("/")
    expect(validateRedirect("/").rejected).toBe(false)
  })

  test("handles null/undefined", () => {
    expect(validateRedirect(null).url).toBe("/")
    expect(validateRedirect(null).rejected).toBe(false)
    expect(validateRedirect(undefined).url).toBe("/")
    expect(validateRedirect(undefined).rejected).toBe(false)
  })

  test("handles empty string", () => {
    expect(validateRedirect("").url).toBe("/")
    expect(validateRedirect("").rejected).toBe(false)
  })

  // Security: Protocol-relative URLs
  test("rejects protocol-relative URLs", () => {
    const result = validateRedirect("//evil.com")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("protocol_relative")
  })

  test("rejects protocol-relative URLs with paths", () => {
    const result = validateRedirect("//evil.com/path")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("protocol_relative")
  })

  // Security: Absolute URLs
  test("rejects absolute URLs", () => {
    const result = validateRedirect("https://evil.com")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("not_relative_path")
  })

  test("rejects URLs with other protocols", () => {
    expect(validateRedirect("javascript:alert(1)").rejected).toBe(true)
    expect(validateRedirect("data:text/html,<script>").rejected).toBe(true)
  })

  // Security: API routes
  test("rejects API routes", () => {
    const result = validateRedirect("/api/admin/delete-all")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("api_route")
  })

  test("rejects any /api path", () => {
    expect(validateRedirect("/api/").rejected).toBe(true)
    expect(validateRedirect("/api/auth/callback").rejected).toBe(true)
  })

  // Security: Auth routes
  test("rejects login route", () => {
    const result = validateRedirect("/login")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("auth_route")
  })

  test("rejects logout route", () => {
    const result = validateRedirect("/logout")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("auth_route")
  })

  test("rejects login/logout with query params", () => {
    expect(validateRedirect("/login?error=something").rejected).toBe(true)
    expect(validateRedirect("/logout?reason=expired").rejected).toBe(true)
    expect(validateRedirect("/login?redirect=/dashboard").reason).toBe(
      "auth_route",
    )
  })

  // URL encoding
  test.each([
    "/act-on-behalf?ownerUserId=external%7Cowner%2Bid%26not%3Da-query",
    "/to-dos?value=%25%252F%23%3F%5C&space=one+two#part%23one",
    "/lists/item/a%2Fb?filter=%2525252525252525",
  ])("preserves escaped URL components and is idempotent: %s", (path) => {
    expect(validateRedirect(path)).toEqual({ url: path, rejected: false })
    expect(getValidRedirect(getValidRedirect(path))).toBe(path)
    expect(getValidRedirect(encodeURIComponent(path))).toBe(path)
    expect(getValidRedirect(encodeURIComponent(encodeURIComponent(path)))).toBe(
      path,
    )
  })

  test.each([
    "%2F%2Fevil.com",
    "/%252Fevil.com",
    "/\\evil.com",
    "/%255Cevil.com",
    "/safe\\path",
    "/\t/evil.com",
    "/%250A/evil.com",
    "/safe/../api/auth/callback",
    "/safe/%2e%2e/login#fragment",
    "/%256Cogout?next=/to-dos",
    "/login#fragment",
  ])("rejects encoded or normalized unsafe paths: %s", (path) => {
    expect(validateRedirect(path).rejected).toBe(true)
    expect(getValidRedirect(path)).toBe("/")
  })

  test("handles URL encoding", () => {
    expect(validateRedirect("%2Fto-dos").url).toBe("/to-dos")
  })

  test.each(["%3F", "%23", "%253f", "%2523"])(
    "rejects traversal hidden behind an encoded delimiter: %s",
    (delimiter) => {
      for (const parent of ["..", "%2e%2e", ".%2e", "%2e."]) {
        for (const target of ["/api/auth/logout", "/logout", "/login"]) {
          const path = `/safe${delimiter}/${parent}${target}`
          expect(new URL(path, "https://dashboard.example.test").pathname).toBe(
            target,
          )
          expect(validateRedirect(path)).toEqual({
            url: "/",
            rejected: true,
            reason: target.startsWith("/api/") ? "api_route" : "auth_route",
          })
          expect(getValidRedirect(encodeURIComponent(path))).toBe("/")
        }
      }
    },
  )

  test.each([
    "/safe%3F/../to-dos?ownerUserId=external%7Cowner%2Bid%26not%3Da-query",
    "/safe%23/../to-dos#section%23one",
    "/to-dos?value=%3F/../api/auth/logout",
    "/to-dos#value=%23/../logout",
  ])("preserves safe encoded delimiters and query data: %s", (path) => {
    expect(validateRedirect(path)).toEqual({ url: path, rejected: false })
  })

  test("handles double-encoded paths", () => {
    // %252F = double-encoded /
    const result = validateRedirect("%252Fto-dos")
    expect(result.url).toBe("/to-dos")
    expect(result.rejected).toBe(false)
  })

  test("rejects excessive encoding (ReDoS protection)", () => {
    // Create deeply nested encoding
    let encoded = "//evil.com"
    for (let i = 0; i < 10; i++) {
      encoded = encodeURIComponent(encoded)
    }
    const result = validateRedirect(encoded)
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("excessive_encoding")
  })

  test("rejects invalid encoding", () => {
    const result = validateRedirect("%ZZ")
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe("invalid_encoding")
  })

  // Security: Host manipulation
  test("allows @ in paths (not actual host manipulation)", () => {
    // /redirect@evil.com is a valid relative path - the @ is just part of the path
    // When parsed with localhost base: http://localhost/redirect@evil.com
    // hostname remains localhost, so this is safe
    const result = validateRedirect("/redirect@evil.com")
    expect(result.rejected).toBe(false)
    expect(result.url).toBe("/redirect@evil.com")
  })

  test("rejects backslash-based attacks", () => {
    // Some parsers treat \ as /
    const result = validateRedirect("/\\evil.com")
    // Should either reject or normalize to safe path
    expect(result.url === "/" || result.url.startsWith("/\\")).toBe(true)
  })
})

describe("getValidRedirect", () => {
  test("returns URL string for valid redirect", () => {
    expect(getValidRedirect("/to-dos")).toBe("/to-dos")
  })

  test("returns / for rejected redirect", () => {
    expect(getValidRedirect("//evil.com")).toBe("/")
    expect(getValidRedirect("https://evil.com")).toBe("/")
  })

  test("returns / for null/undefined", () => {
    expect(getValidRedirect(null)).toBe("/")
    expect(getValidRedirect(undefined)).toBe("/")
  })
})
