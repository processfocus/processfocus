import { describe, expect, test } from "vitest"
import {
  getDummyBypassUserForAuthCallback,
  getDummyBypassUserMissingMessage,
  getLoginErrorForAuthCallback,
} from "../lib/auth/callback-error"

describe("getLoginErrorForAuthCallback", () => {
  test("maps access_denied to not_authorized", () => {
    expect(getLoginErrorForAuthCallback("access_denied")).toBe("not_authorized")
  })

  test("maps other errors to auth_failed", () => {
    expect(getLoginErrorForAuthCallback("server_error")).toBe("auth_failed")
    expect(getLoginErrorForAuthCallback(null)).toBe("auth_failed")
  })

  test("extracts dummy unknown-user details", () => {
    expect(
      getDummyBypassUserForAuthCallback(
        "access_denied",
        "Dummy login requires an existing user, but the given bypass user missing@example.com does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.",
      ),
    ).toBe("missing@example.com")
  })

  test("does not pass through unrelated error descriptions", () => {
    expect(
      getDummyBypassUserForAuthCallback(
        "access_denied",
        "Unable to complete sign-in",
      ),
    ).toBeNull()
    expect(
      getDummyBypassUserForAuthCallback(
        "server_error",
        "Dummy login requires an existing user, but the given bypass user missing@example.com does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.",
      ),
    ).toBeNull()
  })

  test("formats dummy unknown-user messages", () => {
    expect(getDummyBypassUserMissingMessage("missing@example.com")).toBe(
      "Dummy login requires an existing user, but the given bypass user missing@example.com does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.",
    )
  })
})
