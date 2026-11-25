import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, test } from "bun:test"

const token = "pforg-restart-test-secret"
const roots: string[] = []
const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const setup = (fetch: (request: Request) => Response | Promise<Response>) => {
  const root = mkdtempSync(join(tmpdir(), "pforg-restart-"))
  roots.push(root)
  const server = Bun.serve({ hostname: "localhost", port: 0, fetch })
  servers.push(server)
  writeFileSync(
    join(root, ".graphql-port.json"),
    JSON.stringify({ port: server.port }),
  )
  const credentialsPath = join(root, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      version: 1,
      baseUrl: "http://localhost:3000",
      accessToken: token,
      expiresAt: "2999-01-01T00:00:00.000Z",
      loginAt: "2026-01-01T00:00:00.000Z",
    }),
  )
  return { PFORG_CREDENTIALS_PATH: credentialsPath, PF_RUNTIME_ROOT: root }
}

const run = async (args: string[], env: Record<string, string>) => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/main.ts"),
      "executions",
      "restart",
      ...args,
    ],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stdout + stderr).not.toContain(token)
  return { stdout, stderr, exitCode }
}

// This boundary owns CLI parsing, authenticated HTTP, JSON output and exit status.
// Runtime restart semantics are covered separately against the real resolver/DB.
test("sends the execution ID as a mutation variable and prints the backend count", async () => {
  let body: unknown
  const captured: { authorization: string | null } = { authorization: null }
  const env = setup(async (request) => {
    captured.authorization = request.headers.get("authorization")
    body = await request.json()
    return Response.json({
      data: {
        restartExecution: { success: true, restartedCount: 3, error: null },
      },
    })
  })
  const result = await run(["execution-123"], env)
  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: '{"success":true,"restartedCount":3,"error":null}\n',
  })
  expect(captured.authorization).toBe(`Bearer ${token}`)
  expect(body).toEqual({
    query: expect.stringMatching(
      /mutation RestartExecution\(\$executionId: ID!\)/,
    ),
    variables: { executionId: "execution-123" },
  })
})

test.each([
  "Execution not found: missing",
  "Not authorized to restart this execution",
  "No failed todos found for this execution",
  null,
  `Rejected ${token}`,
])("fails on backend rejection: %s", async (error) => {
  const env = setup(() =>
    Response.json({
      data: { restartExecution: { success: false, restartedCount: 0, error } },
    }),
  )
  const result = await run(["execution-123"], env)
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toContain(
    error?.replaceAll(token, "[REDACTED]") ||
      "Check the execution's state and your restart permission.",
  )
})

test.each([
  {
    body: { errors: [{ message: `Permission denied ${token}` }] },
    status: 200,
    message: "Permission denied [REDACTED]",
  },
  { body: {}, status: 401, message: "pforg auth login" },
  { body: {}, status: 503, message: "status 503" },
  {
    body: { data: { restartExecution: { success: true } } },
    status: 200,
    message: "invalid payload",
  },
])(
  "fails safely on HTTP/GraphQL/invalid result: $message",
  async ({ body, status, message }) => {
    const env = setup(() => Response.json(body, { status }))
    const result = await run(["execution-123"], env)
    expect(result).toMatchObject({ exitCode: 1, stdout: "" })
    expect(result.stderr).toContain(message)
  },
)

test.each(
  [[], [" "], ["execution-123", "--unknown"]].map((args) => ({ args })),
)("rejects invalid arguments: %j", async ({ args }) => {
  const result = await run(args, { PFORG_CREDENTIALS_PATH: "/does/not/exist" })
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).not.toContain("Authentication required")
})

test("requires credentials", async () => {
  const result = await run(["execution-123"], {
    PFORG_CREDENTIALS_PATH: "/does/not/exist",
  })
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toContain("pforg auth login")
})

test("rejects expired credentials before sending a request", async () => {
  let called = false
  const env = setup(() => {
    called = true
    return Response.json({})
  })
  writeFileSync(
    env.PFORG_CREDENTIALS_PATH,
    JSON.stringify({
      version: 1,
      baseUrl: "http://localhost:3000",
      accessToken: token,
      expiresAt: "2000-01-01T00:00:00.000Z",
      loginAt: "1999-01-01T00:00:00.000Z",
    }),
  )
  const result = await run(["execution-123"], env)
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toContain("pforg auth login")
  expect(called).toBe(false)
})

test("reports connection failures without printing credentials", async () => {
  const env = setup(() => Response.json({}))
  for (const server of servers) server.stop(true)
  const result = await run(["execution-123"], env)
  expect(result).toMatchObject({ exitCode: 1, stdout: "" })
  expect(result.stderr).toContain("Failed to call GraphQL endpoint")
})
