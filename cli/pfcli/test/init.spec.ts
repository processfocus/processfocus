import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"
import { runInit } from "../src/commands/init"
import {
  getFailureMessage,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

useSerializedTestState()

const tempDirs: string[] = []

const cleanupDir = (dir: string) => {
  rmSync(dir, { force: true, recursive: true })
}

describe("pfcli init", () => {
  afterEach(() => {
    for (const dir of tempDirs) cleanupDir(dir)
    tempDirs.length = 0
  })

  it("full entrypoint smoke requires identity-provider and email options", () => {
    const parentDir = mkdtempSync(join(tmpdir(), "test-pfcli-init-missing-"))
    tempDirs.push(parentDir)

    const orgPath = join(parentDir, "my-org")

    const result = spawnSync("bun", [PFCLI, "init", orgPath], {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
    })

    expect(result.status).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toContain("--email")
  })

  it("rejects missing identity providers at the command seam", async () => {
    const parentDir = mkdtempSync(
      join(tmpdir(), "test-pfcli-init-no-provider-"),
    )
    tempDirs.push(parentDir)

    const orgPath = join(parentDir, "my-org")

    const result = await Effect.runPromiseExit(
      Effect.provide(
        runInit(orgPath, [], "admin@example.com"),
        NodeContext.layer,
      ),
    )

    expect(getFailureMessage(result)).toContain(
      "At least one --identity-provider must be supplied",
    )
    expect(getFailureMessage(result)).toContain("google")
  })

  it("rejects invalid email at the command seam", async () => {
    const parentDir = mkdtempSync(join(tmpdir(), "test-pfcli-init-bad-email-"))
    tempDirs.push(parentDir)

    const orgPath = join(parentDir, "my-org")

    const result = await Effect.runPromiseExit(
      Effect.provide(
        runInit(orgPath, ["google"], "not-an-email"),
        NodeContext.layer,
      ),
    )

    expect(getFailureMessage(result)).toContain(
      "A valid --email address is required.",
    )
  })

  it("lists valid providers when --identity-provider help is used", async () => {
    const parentDir = mkdtempSync(
      join(tmpdir(), "test-pfcli-init-provider-help-"),
    )
    tempDirs.push(parentDir)

    const orgPath = join(parentDir, "my-org")

    const result = await runPfcliInProcess([
      "init",
      orgPath,
      "--identity-provider",
      "help",
      "--email",
      "admin@example.com",
    ])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Expected one of the following cases")
    expect(output).toContain("google")
    expect(output).toContain("github")
  })
})
