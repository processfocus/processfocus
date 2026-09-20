import {
  buildFrontendEnv,
  buildNextDevArgv,
  resolveWorkspaceRoot,
} from "./serve-frontend"
import { describe, expect, it } from "bun:test"

describe("serve-frontend launcher helpers", () => {
  it("builds next dev argv without --port when FRONTEND_PORT is unset", () => {
    expect(buildNextDevArgv(undefined)).toEqual(["run", "--bun", "next", "dev"])
  })

  it("builds next dev argv without --port when FRONTEND_PORT is empty", () => {
    expect(buildNextDevArgv("")).toEqual(["run", "--bun", "next", "dev"])
  })

  it("adds --port when FRONTEND_PORT is set", () => {
    expect(buildNextDevArgv("4173")).toEqual([
      "run",
      "--bun",
      "next",
      "dev",
      "--port",
      "4173",
    ])
  })

  it("prefers NX_WORKSPACE_ROOT over path derivation", () => {
    expect(
      resolveWorkspaceRoot({ NX_WORKSPACE_ROOT: "/tmp/workspace" }, "/unused"),
    ).toBe("/tmp/workspace")
  })

  it("derives workspace root from launcher directory when NX_WORKSPACE_ROOT is unset", () => {
    expect(resolveWorkspaceRoot({}, "/repo/runtime/local/src")).toBe("/repo")
  })

  it("owns the local organisation frontend plugin composition", () => {
    expect(buildFrontendEnv("/repo", "token", {})).toMatchObject({
      FRONTEND_JWT_TOKEN: "token",
      NX_WORKSPACE_ROOT: "/repo",
    })
  })

  it("passes the selected organisation and environment to preparation", () => {
    expect(
      buildFrontendEnv("/repo", "token", { PF_ORG: "/org-a", PF_ENV: "dev" }),
    ).toEqual({
      FRONTEND_JWT_TOKEN: "token",
      NX_WORKSPACE_ROOT: "/repo",
      PF_ORG: "/org-a",
      PF_ENV: "dev",
    })
  })
})
