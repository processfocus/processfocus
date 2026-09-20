import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import { pathToPascalCase as pforgPathToPascalCase } from "../src/commands/process/start"
import { afterEach, describe, expect, test } from "bun:test"

const PFORG = resolve(import.meta.dir, "../src/main.ts")
const ACCESS_TOKEN = "pforg-process-start-secret-token"

const GraphqlRequestSchema = Schema.Struct({ query: Schema.String })
const PathConversionFixturesSchema = Schema.Array(
  Schema.Struct({ input: Schema.String, expected: Schema.String }),
)

const rawPathConversionFixtures: unknown = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../../../packages/process/test-fixtures/path-to-pascal-case.json",
    ),
    "utf8",
  ),
)
const pathConversionFixtures = Schema.decodeUnknownSync(
  PathConversionFixturesSchema,
)(rawPathConversionFixtures)

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

const writeTestCredentials = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: "http://localhost:3000",
      accessToken: ACCESS_TOKEN,
      expiresAt: "2999-08-29T01:02:03.000Z",
      loginAt: "2026-08-29T00:00:00.000Z",
    }),
  )
}

type GraphqlHandler = (
  query: string,
  request: Request,
) => unknown | Promise<unknown>

const startGraphqlServer = (root: string, handler: GraphqlHandler) => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(GraphqlRequestSchema)(
        await request.json(),
      )
      return Response.json(await handler(body.query, request))
    },
  })
  writeFileSync(
    join(root, ".graphql-port.json"),
    JSON.stringify({ port: server.port }),
  )
  return server
}

const startPayload = {
  executionId: "pex-123",
  processId: "process-456",
  processPath: "/engineering/bug-report",
  timestamp: "2026-08-29T01:02:03.000Z",
  deduplicated: false,
}

describe("pforg process start", () => {
  const tempPaths: string[] = []
  const servers: Array<Bun.Server<undefined>> = []

  afterEach(() => {
    for (const server of servers) server.stop(true)
    servers.length = 0
    for (const path of tempPaths) {
      rmSync(path, { recursive: true, force: true })
    }
    tempPaths.length = 0
  })

  const setup = (handler: GraphqlHandler) => {
    const root = mkdtempSync(join(tmpdir(), "pforg-process-start-"))
    tempPaths.push(root)
    const credentialsPath = join(root, "credentials.json")
    writeTestCredentials(credentialsPath)
    servers.push(startGraphqlServer(root, handler))
    return {
      PFORG_CREDENTIALS_PATH: credentialsPath,
      PF_RUNTIME_ROOT: root,
    }
  }

  test("keeps mutation path conversion aligned with the process model", () => {
    for (const fixture of pathConversionFixtures) {
      expect(pforgPathToPascalCase(fixture.input)).toBe(fixture.expected)
    }
  })

  test("derives the mutation, passes JSON input, and prints the immediate payload", async () => {
    let receivedQuery = ""
    const environment = setup((query, request) => {
      receivedQuery = query
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      )
      return { data: { startEngineeringBugReport: startPayload } }
    })

    const result = await runPforg(
      [
        "process",
        "start",
        "engineering/bug-report",
        "--input",
        '{"field":"value"}',
      ],
      environment,
    )

    expect(result.exitCode).toBe(0)
    expect(receivedQuery).toContain(
      'startEngineeringBugReport(input: {field: "value"})',
    )
    expect(receivedQuery).not.toContain(ACCESS_TOKEN)
    expect(result.stdout.trim()).toBe(JSON.stringify(startPayload))
    expect(result.stderr).toBe("")
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
  })

  test("omits the input argument for a no-input Process", async () => {
    let receivedQuery = ""
    const environment = setup((query) => {
      receivedQuery = query
      return { data: { startOperationsNightlySync: startPayload } }
    })

    const result = await runPforg(
      ["process", "start", "/operations/nightly-sync"],
      environment,
    )

    expect(result.exitCode).toBe(0)
    expect(receivedQuery).toContain("startOperationsNightlySync {")
    expect(receivedQuery).not.toContain("input:")
    expect(result.stdout.trim()).toBe(JSON.stringify(startPayload))
  })

  test("rejects invalid JSON before calling GraphQL", async () => {
    let graphqlCalled = false
    const environment = setup(() => {
      graphqlCalled = true
      return { data: {} }
    })

    const result = await runPforg(
      ["process", "start", "engineering/bug-report", "--input", '{"field":'],
      environment,
    )

    expect(result.exitCode).toBe(1)
    expect(graphqlCalled).toBe(false)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--input must be valid JSON")
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
  })

  test("surfaces missing required fields as a GraphQL error", async () => {
    const environment = setup(() => ({
      errors: [
        {
          message: 'Field "item" of required type "String!" was not provided.',
        },
      ],
    }))

    const result = await runPforg(
      ["process", "start", "engineering/bug-report", "--input", "{}"],
      environment,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(
      'GraphQL error: Field "item" of required type "String!" was not provided.',
    )
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
  })

  test("redacts the access token if a GraphQL error echoes it", async () => {
    const environment = setup(() => ({
      errors: [{ message: `Request rejected for ${ACCESS_TOKEN}` }],
    }))

    const result = await runPforg(
      ["process", "start", "engineering/bug-report"],
      environment,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("[REDACTED]")
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
  })
})
