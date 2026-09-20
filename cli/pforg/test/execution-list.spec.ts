import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

const PFORG = resolve(import.meta.dir, "../src/main.ts")
const ACCESS_TOKEN = "pforg-execution-test-token"

type EnvironmentOverrides = Readonly<Record<string, string | undefined>>

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const commandEnvironment = (
  overrides: EnvironmentOverrides,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries({
    ...process.env,
    ...overrides,
  })) {
    if (value !== undefined) environment[name] = value
  }
  return environment
}

const runPforg = async (
  args: readonly string[],
  environment: EnvironmentOverrides,
): Promise<CommandResult> => {
  const subprocess = Bun.spawn([process.execPath, PFORG, ...args], {
    env: commandEnvironment(environment),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return { stdout, stderr, exitCode }
}

const writeCredentials = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: "http://localhost:3000",
      accessToken: ACCESS_TOKEN,
      expiresAt: "2999-08-29T00:00:00.000Z",
      loginAt: "2026-08-29T00:00:00.000Z",
    }),
  )
}

describe("pforg executions list", () => {
  const tempPaths: string[] = []
  const servers: Bun.Server<unknown>[] = []

  afterEach(() => {
    for (const server of servers) server.stop(true)
    servers.length = 0
    for (const path of tempPaths) rmSync(path, { recursive: true, force: true })
    tempPaths.length = 0
  })

  test("prints only Execution list nodes and maps every list flag", async () => {
    const captured: {
      requestBody: unknown
      authorization: string | null
    } = { requestBody: undefined, authorization: null }
    const execution = {
      id: "execution-1",
      processPath: "/finance/purchase-request",
      processName: "Purchase Request",
      status: "Running",
      startedAt: "2026-08-29T01:02:03.000Z",
      finishedAt: null,
      completedSteps: 1,
      totalSteps: 2,
      failureReason: null,
    }
    const server = Bun.serve({
      hostname: "localhost",
      port: 0,
      async fetch(request) {
        captured.authorization = request.headers.get("Authorization")
        captured.requestBody = await request.json()
        return Response.json({ data: { executions: { nodes: [execution] } } })
      },
    })
    servers.push(server)

    const root = mkdtempSync(join(tmpdir(), "pforg-executions-"))
    tempPaths.push(root)
    const credentialsPath = join(root, "credentials.json")
    writeCredentials(credentialsPath)
    writeFileSync(
      join(root, ".graphql-port.json"),
      JSON.stringify({ port: server.port }),
    )

    const result = await runPforg(
      [
        "executions",
        "list",
        "--page",
        "2",
        "--limit",
        "25",
        "--process-path",
        "/finance/purchase-request",
        "--status",
        "Running",
      ],
      {
        PFORG_CREDENTIALS_PATH: credentialsPath,
        PF_RUNTIME_ROOT: root,
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual([execution])
    expect(Object.keys(JSON.parse(result.stdout)[0]).toSorted()).toEqual(
      Object.keys(execution).toSorted(),
    )
    expect(captured.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(captured.requestBody).toMatchObject({
      variables: {
        page: 2,
        limit: 25,
        processPath: "/finance/purchase-request",
        status: "Running",
      },
    })
  })

  test("prints an empty JSON array with default list flags", async () => {
    const captured: { requestBody: unknown } = { requestBody: undefined }
    const server = Bun.serve({
      hostname: "localhost",
      port: 0,
      async fetch(request) {
        captured.requestBody = await request.json()
        return Response.json({ data: { executions: { nodes: [] } } })
      },
    })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), "pforg-empty-executions-"))
    tempPaths.push(root)
    const credentialsPath = join(root, "credentials.json")
    writeCredentials(credentialsPath)
    writeFileSync(
      join(root, ".graphql-port.json"),
      JSON.stringify({ port: server.port }),
    )

    const result = await runPforg(["executions", "list"], {
      PFORG_CREDENTIALS_PATH: credentialsPath,
      PF_RUNTIME_ROOT: root,
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: "[]\n", stderr: "" })
    expect(captured.requestBody).toMatchObject({
      variables: { page: 1, limit: 50, processPath: null, status: null },
    })
  })

  test("rejects limits above 100 before reading credentials", async () => {
    const result = await runPforg(["executions", "list", "--limit", "101"], {
      PFORG_CREDENTIALS_PATH: "/does/not/exist",
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("❌ --limit must be between 1 and 100\n")
  })
})
