import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import type { CliError } from "../src/errors"
import { captureStdout, loadPfcliCommand } from "./test-helpers"
import { describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

const loadSkillsCommand = async () =>
  loadPfcliCommand<{
    runSkillsList: () => Effect.Effect<void>
    runSkillsGet: (name: string) => Effect.Effect<void, CliError>
  }>("skills")

describe("pfcli skills", () => {
  it("lists runtime skills", async () => {
    const { runSkillsList } = await loadSkillsCommand()

    const { output } = await captureStdout(() =>
      Effect.runPromise(runSkillsList()),
    )

    expect(output).toContain("core\tCore pfcli workflows")
  })

  it("prints the core runtime skill", async () => {
    const { runSkillsGet } = await loadSkillsCommand()

    const { output } = await captureStdout(() =>
      Effect.runPromise(runSkillsGet("core")),
    )

    expect(output).toContain("# pfcli agent skill")
    expect(output).toContain("pfcli deploy <org-path>")
    expect(output).toContain("pfcli destroy --project <project-number>")
    expect(output).toContain("This is destructive")
    expect(output).toContain("TursoDB targets use logical dump replay")
    expect(output).toContain("Do not print, persist, or quote access tokens")
  })

  it("reports unknown skills with the available skill names", () => {
    const result = spawnSync("bun", [PFCLI, "skills", "get", "missing"], {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown pfcli skill "missing"')
    expect(result.stderr).toContain("Available skills: core")
  })
})
