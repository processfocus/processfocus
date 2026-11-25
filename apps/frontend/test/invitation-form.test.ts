import { Schema } from "effect"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import { invitationForm } from "../lib/forms/invitation"
import { describe, expect, test } from "bun:test"

describe("invitation form submission", () => {
  const schema = invitationForm([{ value: "admin", label: "Administrator" }])
  const decode = Schema.decodeUnknownSync(submissionSchemaSync(schema))

  test.each([
    ["", "Email is required"],
    ["   ", "Email is required"],
    ["person", "Enter a valid email address"],
    ["person@example", "Enter a valid email address"],
    ["person @example.com", "Enter a valid email address"],
  ])("rejects %j with an actionable error", (email, message) => {
    expect(() => decode({ email, roleIds: ["admin"] })).toThrow(message)
  })

  test("flattens wrappers, trims email, and retains unavailable roles", () => {
    expect(
      decode({ email: "  Person+test@Example.com  ", roleIds: ["retired"] }),
    ).toEqual({
      email: "Person+test@Example.com",
      roleIds: ["retired"],
    })
  })

  test("requires an invitation grant even though provider users may have no roles", () => {
    expect(() => decode({ email: "person@example.com", roleIds: [] })).toThrow(
      "Select at least one role",
    )
  })
})
