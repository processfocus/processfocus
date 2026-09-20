import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

useSerializedTestState()

type RunLogs = (projectId: string, environmentId: string) => Effect.Effect<void>

const loadRunLogs = async (): Promise<RunLogs> => {
  const module = await loadPfcliCommand<{
    runLogs: RunLogs
  }>("logs")

  return module.runLogs
}

const loadRunCanaryLogs = async (): Promise<RunLogs> => {
  const module = await loadPfcliCommand<{
    runCanaryLogs: RunLogs
  }>("logs")

  return module.runCanaryLogs
}

const createCredentialsFile = (baseDir: string) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl: "http://mocked.test",
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

describe("pfcli logs", () => {
  const tempPaths: string[] = []
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  afterEach(() => {
    for (const server of servers) {
      server.stop(true)
    }
    servers.length = 0

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

  it("calls getRuntimeLogs with PRIMARY and prints raw timestamped messages without runtime metadata", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(testDir)

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: Record<string, unknown>
      }

      expect(body.query).toContain("getRuntimeLogs")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
        environmentId: "prd",
        target: "PRIMARY",
        limit: 100,
      })

      return new Response(
        JSON.stringify({
          data: {
            getRuntimeLogs: {
              events: [
                {
                  timestamp: "2026-04-27T10:00:00.000Z",
                  message: "first log",
                  color: "metadata-color-green",
                  logGroupName: "/pf/0000-0000-0002/prd/green",
                  awsAccountId: "000000000000",
                  regionName: "us-west-2",
                  logStreamName: "primary-stream",
                },
                {
                  timestamp: "2026-04-27T10:00:01.000Z",
                  message:
                    '{"level":"info","message":"raw json","token":"raw-token"}',
                  color: "metadata-color-blue",
                  logGroupName: "/pf/0000-0000-0002/prd/blue",
                  awsAccountId: "000000000000",
                  regionName: "us-west-2",
                  logStreamName: "other-stream",
                },
              ],
              logGroupName: "/pf/0000-0000-0002/prd/green",
              regionName: "us-west-2",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runLogs = await loadRunLogs()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runLogs("0000-0000-0002", "prd")),
    )

    expect(output.trim()).toBe(
      'Showing recent primary logs.\n2026-04-27T10:00:00.000Z first log\n2026-04-27T10:00:01.000Z {"level":"info","message":"raw json","token":"raw-token"}',
    )
    expect(output).not.toContain("metadata-color-green")
    expect(output).not.toContain("metadata-color-blue")
    expect(output).not.toContain("/pf/0000-0000-0002/prd")
    expect(output).not.toContain("000000000000")
    expect(output).not.toContain("us-west-2")
    expect(output).not.toContain("primary-stream")
    expect(output).not.toContain("other-stream")
  })

  it(
    "documents the primary and canary log command purposes in help output",
    async () => {
      const help = await runPfcliInProcess(["--help"])

      expect(help.status).toBe(0)
      expect(help.output).toContain("logs")
      expect(help.output).toContain("Show recent primary runtime logs")
      expect(help.output).toContain("canary-logs")
      expect(help.output).toContain("Show recent canary runtime logs")
      expect(help.output).not.toContain("last-hour snapshot")
    },
    { timeout: 15_000 },
  )

  it("prints an empty-state message when no primary logs are returned", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(testDir)

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getRuntimeLogs: {
              events: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runLogs = await loadRunLogs()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runLogs("0000-0000-0002", "prd")),
    )

    expect(output.trim()).toBe(
      "Showing recent primary logs.\nNo recent primary logs found.",
    )
  })

  it("calls getRuntimeLogs with CANARY and prints canary log output", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(testDir)

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: Record<string, unknown>
      }

      expect(body.query).toContain("getRuntimeLogs")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
        environmentId: "prd",
        target: "CANARY",
        limit: 100,
      })

      return new Response(
        JSON.stringify({
          data: {
            getRuntimeLogs: {
              events: [
                {
                  timestamp: "2026-04-27T10:00:00.000Z",
                  message: "canary log",
                  color: "metadata-color-canary",
                  logGroupName: "/pf/0000-0000-0002/prd/canary",
                  awsAccountId: "000000000000",
                  regionName: "us-west-2",
                  logStreamName: "canary-stream",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runCanaryLogs = await loadRunCanaryLogs()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCanaryLogs("0000-0000-0002", "prd")),
    )

    expect(output.trim()).toBe(
      "Showing recent canary logs.\n2026-04-27T10:00:00.000Z canary log",
    )
    expect(output).not.toContain("metadata-color-canary")
    expect(output).not.toContain("/pf/0000-0000-0002/prd/canary")
    expect(output).not.toContain("000000000000")
    expect(output).not.toContain("us-west-2")
    expect(output).not.toContain("canary-stream")
  })

  it("prints an empty-state message when no canary logs are returned", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(testDir)

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getRuntimeLogs: {
              events: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCanaryLogs = await loadRunCanaryLogs()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCanaryLogs("0000-0000-0002", "prd")),
    )

    expect(output.trim()).toBe(
      "Showing recent canary logs.\nNo recent canary logs found.",
    )
  })

  it("fails clearly when project or environment is missing", async () => {
    const result = await runPfcliInProcess(["logs"])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain(
      "Missing required logs option(s): --project, --env.",
    )
  })

  it("fails clearly when canary project or environment is missing", async () => {
    const result = await runPfcliInProcess(["canary-logs"])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain(
      "Missing required canary-logs option(s): --project, --env.",
    )
  })

  it("registers logs as a top-level command without org path", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)

    let requestVariables: Record<string, unknown> | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          query?: string
          variables?: Record<string, unknown>
        }
        expect(new URL(request.url).pathname).toBe("/graphql")
        if (body.query?.includes("listProjectEnvironments")) {
          return Response.json({
            data: {
              listProjectEnvironments: {
                items: [{ environmentName: "prd" }],
              },
            },
          })
        }

        if (body.query?.includes("hostingContract")) {
          return Response.json({
            data: {
              hostingContract: {
                format: "processfocus/hosting-contract",
                version: 1,
                major: 1,
                capabilities: ["logs"],
              },
            },
          })
        }

        expect(body.query).toContain("getRuntimeLogs")
        requestVariables = body.variables

        return Response.json({
          data: {
            getRuntimeLogs: {
              events: [
                {
                  timestamp: "2026-04-27T10:00:00.000Z",
                  message: "from cli",
                },
              ],
            },
          },
        })
      },
    })
    servers.push(server)

    const credentialsPath = createCredentialsFile(testDir)
    const credentials = JSON.parse(
      readFileSync(credentialsPath, "utf8"),
    ) as Record<string, unknown>
    credentials["baseUrl"] = `http://0.0.0.0:${server.port}`
    writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`)

    const child = Bun.spawn(
      ["bun", PFCLI, "logs", "--project", "0000-0000-0002", "--env", "prd"],
      {
        cwd: WORKSPACE_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PFCLI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(`${stdout}${stderr}`).not.toContain("org-path")
    expect(exitCode).toBe(0)
    expect(requestVariables).toEqual({
      projectId: "0000-0000-0002",
      environmentId: "prd",
      target: "PRIMARY",
      limit: 100,
    })
    expect(stdout).toContain("Showing recent primary logs.")
    expect(stdout).toContain("2026-04-27T10:00:00.000Z from cli")
  })

  it("prints backend GraphQL errors with the pfcli error style", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          query?: string
        }
        if (body.query?.includes("listProjectEnvironments")) {
          return Response.json({
            data: {
              listProjectEnvironments: {
                items: [{ environmentName: "prd" }],
              },
            },
          })
        }

        return Response.json({
          errors: [
            {
              message:
                "Logs are not configured for this environment yet. Redeploy the environment or contact support.",
            },
          ],
        })
      },
    })
    servers.push(server)

    const credentialsPath = createCredentialsFile(testDir)
    const credentials = JSON.parse(
      readFileSync(credentialsPath, "utf8"),
    ) as Record<string, unknown>
    credentials["baseUrl"] = `http://0.0.0.0:${server.port}`
    writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`)

    const child = Bun.spawn(
      ["bun", PFCLI, "logs", "--project", "0000-0000-0002", "--env", "prd"],
      {
        cwd: WORKSPACE_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PFCLI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const output = `${stdout}${stderr}`

    expect(exitCode).not.toBe(0)
    expect(output).toContain(
      "❌ GraphQL error: Logs are not configured for this environment yet. Redeploy the environment or contact support.",
    )
    expect(output).not.toContain("arn:aws")
    expect(output).not.toContain("123456789012")
    expect(output).not.toContain("us-west-2")
    expect(output).not.toContain("pf-console-ops")
    expect(output).not.toContain("/pf/2781-7720-6987/prd/green")
  })

  it("registers canary-logs as a top-level command without org path", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-logs-test-"))
    tempPaths.push(testDir)

    let requestVariables: Record<string, unknown> | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          query?: string
          variables?: Record<string, unknown>
        }
        expect(new URL(request.url).pathname).toBe("/graphql")
        if (body.query?.includes("listProjectEnvironments")) {
          return Response.json({
            data: {
              listProjectEnvironments: {
                items: [{ environmentName: "prd" }],
              },
            },
          })
        }

        if (body.query?.includes("hostingContract")) {
          return Response.json({
            data: {
              hostingContract: {
                format: "processfocus/hosting-contract",
                version: 1,
                major: 1,
                capabilities: ["logs"],
              },
            },
          })
        }

        expect(body.query).toContain("getRuntimeLogs")
        requestVariables = body.variables

        return Response.json({
          data: {
            getRuntimeLogs: {
              events: [],
            },
          },
        })
      },
    })
    servers.push(server)

    const credentialsPath = createCredentialsFile(testDir)
    const credentials = JSON.parse(
      readFileSync(credentialsPath, "utf8"),
    ) as Record<string, unknown>
    credentials["baseUrl"] = `http://0.0.0.0:${server.port}`
    writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`)

    const child = Bun.spawn(
      [
        "bun",
        PFCLI,
        "canary-logs",
        "--project",
        "0000-0000-0002",
        "--env",
        "prd",
      ],
      {
        cwd: WORKSPACE_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PFCLI_CREDENTIALS_PATH: credentialsPath,
        },
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(`${stdout}${stderr}`).not.toContain("org-path")
    expect(exitCode).toBe(0)
    expect(requestVariables).toEqual({
      projectId: "0000-0000-0002",
      environmentId: "prd",
      target: "CANARY",
      limit: 100,
    })
    expect(stdout).toContain("Showing recent canary logs.")
    expect(stdout).toContain("No recent canary logs found.")
  })
})
