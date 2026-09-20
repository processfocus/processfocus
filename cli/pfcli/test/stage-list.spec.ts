import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

useSerializedTestState()

type RunStageList = (projectId: string) => Effect.Effect<void, unknown>

const loadRunStageList = async (): Promise<RunStageList> => {
  const module = await loadPfcliCommand<{
    runStageList: RunStageList
  }>("stage/list")

  return module.runStageList
}

const createCredentialsFile = (baseDir: string, baseUrl: string) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl,
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        loginAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  return credentialsPath
}

describe("pfcli stage list", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  afterEach(() => {
    for (const tempPath of tempPaths) {
      rmSync(tempPath, { recursive: true, force: true })
    }
    tempPaths.length = 0
    globalThis.fetch = originalFetch

    if (originalCredPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
    }
  })

  it("calls the project-scoped stage list query and prints stage names only", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-list-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: {
          projectId?: string
        }
      }

      expect(body.query).toContain("listProjectStages")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
      })

      return new Response(
        JSON.stringify({
          data: {
            listProjectStages: {
              items: [
                { stageName: "Development" },
                { stageName: "Production" },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runStageList = await loadRunStageList()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runStageList("0000-0000-0002")),
    )

    expect(output.trim()).toBe("Development\nProduction")
  })

  it("prints a clear empty-state message when the project has no stages", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-list-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjectStages: {
              items: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runStageList = await loadRunStageList()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runStageList("0000-0000-0002")),
    )

    expect(output).toContain("No stages found for project 0000-0000-0002.")
  })

  it("requires --project on the CLI", async () => {
    const result = await runPfcliInProcess(["stage", "list"])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("--project")
  })
})
