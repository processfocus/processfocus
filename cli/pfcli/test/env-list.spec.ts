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

type RunEnvList = (
  projectId: string,
  stageId?: string,
) => Effect.Effect<void, unknown>

const loadRunEnvList = async (): Promise<RunEnvList> => {
  const module = await loadPfcliCommand<{
    runEnvList: RunEnvList
  }>("env/list")

  return module.runEnvList
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

describe("pfcli env list", () => {
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

  it("calls the project-scoped environment list query and prints environment plus stage", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-list-test-"))
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
          stageId?: string
        }
      }

      expect(body.query).toContain("listProjectEnvironments")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
      })

      return new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: {
              items: [
                { environmentName: "dev", stageName: "Development" },
                { environmentName: "prd", stageName: "Production" },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runEnvList = await loadRunEnvList()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runEnvList("0000-0000-0002")),
    )

    expect(output.trim()).toBe("dev (Development)\nprd (Production)")
  })

  it("passes the optional stage filter and prints environment names only", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-list-test-"))
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
          stageId?: string
        }
      }

      expect(body.query).toContain("listProjectEnvironments")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
        stageId: "Production",
      })

      return new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: {
              items: [{ environmentName: "prd", stageName: "Production" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runEnvList = await loadRunEnvList()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runEnvList("0000-0000-0002", "Production")),
    )

    expect(output.trim()).toBe("prd")
  })

  it("prints a clear empty-state message when the project has no environments", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-list-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: {
              items: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runEnvList = await loadRunEnvList()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runEnvList("0000-0000-0002")),
    )

    expect(output).toContain(
      "No environments found for project 0000-0000-0002.",
    )
  })

  it("requires --project on the CLI", async () => {
    const result = await runPfcliInProcess(["env", "list"])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("--project")
  })
})
