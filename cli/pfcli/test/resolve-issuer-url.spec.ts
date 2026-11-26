import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveIssuerUrl } from "../src/utils/resolve-issuer-url"
import { captureStdout, useSerializedTestState, withEnv } from "./test-helpers"
import { describe, expect, it } from "bun:test"

useSerializedTestState()

describe("resolveIssuerUrl", () => {
  it("should use OAUTH_ISSUER_URL when set", async () => {
    await withEnv({ OAUTH_ISSUER_URL: "http://auth.example.com" }, async () => {
      expect(resolveIssuerUrl()).toBe("http://auth.example.com")
    })
  })

  it("should read port from .auth-port.json when OAUTH_ISSUER_URL not set", async () => {
    const originalCwd = process.cwd()
    const tempDir = mkdtempSync(join(tmpdir(), "test-resolve-issuer-url-"))
    try {
      process.chdir(tempDir)
      writeFileSync(
        join(tempDir, ".auth-port.json"),
        JSON.stringify({ port: 4025 }),
      )
      await withEnv(
        { OAUTH_ISSUER_URL: undefined, NX_WORKSPACE_ROOT: undefined },
        async () => {
          const { output } = await captureStdout(async () => {
            expect(resolveIssuerUrl()).toBe("http://localhost:4025")
          })
          expect(output).toContain(
            "OAUTH_ISSUER_URL not set — falling back to http://localhost:4025",
          )
        },
      )
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("should fall back to default port 4020 when .auth-port.json not found", async () => {
    const originalCwd = process.cwd()
    const emptyDir = mkdtempSync(join(tmpdir(), "test-no-auth-port-"))
    try {
      process.chdir(emptyDir)
      await withEnv(
        { OAUTH_ISSUER_URL: undefined, NX_WORKSPACE_ROOT: undefined },
        async () => {
          const { output } = await captureStdout(async () => {
            expect(resolveIssuerUrl()).toBe("http://localhost:4020")
          })
          expect(output).toContain(
            "OAUTH_ISSUER_URL not set — falling back to http://localhost:4020",
          )
        },
      )
    } finally {
      process.chdir(originalCwd)
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
