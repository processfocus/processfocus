import {
  runPfcliInProcess,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { describe, expect, it } from "bun:test"

useSerializedTestState()

describe("operator input boundaries", () => {
  it.each([
    {
      args: ["auth", "login", "--base-url", "https://user:private@example.com"],
    },
    { args: ["import", ".", "--issuer-url", "invalid-private"] },
    {
      args: [
        "refresh-frontend-jwt",
        ".",
        "--issuer-url",
        "ftp://private.example.com",
      ],
    },
  ])("rejects invalid URLs before any command work (%#)", async ({ args }) => {
    const result = await runPfcliInProcess(args)
    expect(result.status).toBe(1)
    expect(result.output).toContain("must be an absolute HTTP(S)")
    expect(result.output).not.toContain("private")
  })

  it("rejects a browser login URL in workload auth mode", async () => {
    const result = await withEnv({ PFCLI_AUTH_MODE: "github-workload" }, () =>
      runPfcliInProcess(["auth", "login", "--base-url", "https://example.com"]),
    )
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      "--base-url is not available in OIDC federation auth mode",
    )
  })

  it("rejects a database path for a hosted role grant", async () => {
    const result = await runPfcliInProcess([
      "grant",
      "role",
      "--project",
      "123",
      "--env",
      "dev",
      "--role",
      "/Admin",
      "--user",
      "employee@example.com",
      "--database-path",
      "./ignored.db",
    ])
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      "--database-path applies only to local mode",
    )
  })

  it.each([{ options: ["0"] }, { options: ["100", "--no-wait"] }])(
    "rejects unsuitable deploy timeout options (%#)",
    async ({ options }) => {
      const result = await runPfcliInProcess([
        "deploy",
        ".",
        "--project",
        "123",
        "--env",
        "dev",
        "--wait-timeout-ms",
        ...options,
      ])
      expect(result.status).toBe(1)
      expect(result.output).toContain(
        "--wait-timeout-ms must be a positive integer and cannot be used with --no-wait",
      )
    },
  )
})
