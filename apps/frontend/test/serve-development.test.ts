import { buildDevelopmentEnv } from "../scripts/serve-development"
import { describe, expect, it } from "bun:test"

describe("frontend development environment", () => {
  it("sets the workspace root", () => {
    const env = buildDevelopmentEnv("/repo", {})

    expect(env["NX_WORKSPACE_ROOT"]).toBe("/repo")
  })

  it("preserves the selected organisation", () => {
    const env = buildDevelopmentEnv("/repo", {
      PF_ORG: "/org-a",
    })

    expect(env["PF_ORG"]).toBe("/org-a")
  })
})
