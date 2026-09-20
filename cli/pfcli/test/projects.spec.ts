import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

useSerializedTestState()

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

type RunProjects = () => Effect.Effect<void, unknown>

const loadRunProjects = async (): Promise<RunProjects> => {
  const module = await loadPfcliCommand<{
    runProjects: RunProjects
  }>("projects")

  return module.runProjects
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

const runCliProjects = (env: NodeJS.ProcessEnv) =>
  spawnSync("bun", [PFCLI, "projects"], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env,
  })

describe("pfcli projects", () => {
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

  it("prints project numbers and names", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-projects-test-"))
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
          page?: number
          limit?: number
        }
      }

      expect(body.query).toContain("listProjects")
      expect(body.variables).toEqual({ page: 1, limit: 100 })

      return new Response(
        JSON.stringify({
          data: {
            listProjects: {
              items: [
                {
                  projectNumber: "0000-0000-0001",
                  projectName: "Demo Project",
                },
                {
                  projectNumber: "0000-0000-0002",
                  projectName: "Customer Portal",
                },
              ],
              totalCount: 2,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runProjects = await loadRunProjects()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runProjects()),
    )

    expect(output.trim()).toBe(
      "0000-0000-0001\tDemo Project\n0000-0000-0002\tCustomer Portal",
    )
  })

  it("continues until all project pages have been printed", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-projects-test-"))
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
        variables?: {
          page?: number
          limit?: number
        }
      }

      const page = body.variables?.page ?? 0

      return new Response(
        JSON.stringify({
          data: {
            listProjects: {
              items: [
                {
                  projectNumber: `0000-0000-000${page}`,
                  projectName: `Project ${page}`,
                },
              ],
              totalCount: 2,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runProjects = await loadRunProjects()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runProjects()),
    )

    expect(output.trim()).toBe(
      "0000-0000-0001\tProject 1\n0000-0000-0002\tProject 2",
    )
  })

  it("prints a clear empty-state message", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-projects-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjects: {
              items: [],
              totalCount: 0,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runProjects = await loadRunProjects()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runProjects()),
    )

    expect(output).toContain("No projects found.")
  })

  it("prints authentication guidance and exits non-zero without credentials", () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-projects-test-"))
    tempPaths.push(testDir)

    const result = runCliProjects({
      ...process.env,
      PFCLI_CREDENTIALS_PATH: join(testDir, "missing-credentials.json"),
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Authentication required. Run "pfcli auth login".',
    )
  })
})
