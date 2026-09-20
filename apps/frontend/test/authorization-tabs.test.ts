import { describe, expect, test } from "vitest"
import {
  authorizationTabHref,
  parseAuthorizationTab,
} from "../lib/authorization-tabs"

describe("authorization tabs", () => {
  test("treats a missing segment as access", () => {
    expect(parseAuthorizationTab(undefined)).toBe("access")
  })

  test("accepts known tabs", () => {
    expect(parseAuthorizationTab("policies")).toBe("policies")
  })

  test("rejects unknown tabs", () => {
    expect(parseAuthorizationTab("tab")).toBeNull()
  })

  test("builds path urls", () => {
    expect(authorizationTabHref("policies")).toBe("/settings/cedar/policies")
  })
})
