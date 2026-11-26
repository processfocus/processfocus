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
      PF_RUNTIME_MODE: "deployed",
      PF_STAGE: "production",
      PF_ENV: "dev",
    })

    expect(env["PF_ORG"]).toBe("/org-a")
    expect(env["PF_RUNTIME_MODE"]).toBe("local")
    expect(env["PF_STAGE"]).toBe("production")
    expect(env["PF_ENV"]).toBe("dev")
  })
})
