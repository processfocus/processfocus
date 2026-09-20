import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Option } from "effect"
import { runDatabaseShell } from "../src/commands/db/shell"
import {
  // captureStdout captures stderr too; warnings from this command use stderr.
  captureStdout as captureTerminalOutput,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

useSerializedTestState()

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

const graphqlResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const readGraphqlBody = (init?: RequestInit) =>
  JSON.parse(String(init?.body)) as {
    query: string
    variables: Record<string, unknown>
  }

const getFailureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) {
    return ""
  }

  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    return ""
  }

  const { value } = failure
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message
  }

  return value instanceof Error ? value.message : String(value)
}

describe("pfcli db shell", () => {
  const tempPaths: string[] = []
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalFetch = globalThis.fetch
  const originalLibsqlAuthToken = process.env["LIBSQL_AUTH_TOKEN"]
  const originalTursoAuthToken = process.env["TURSO_AUTH_TOKEN"]
  const originalTursoApiToken = process.env["TURSO_API_TOKEN"]

  afterEach(() => {
    globalThis.fetch = originalFetch

    for (const p of tempPaths) {
      rmSync(p, { recursive: true, force: true })
    }
    tempPaths.length = 0

    if (originalCredPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
    }

    if (originalLibsqlAuthToken === undefined) {
      delete process.env["LIBSQL_AUTH_TOKEN"]
    } else {
      process.env["LIBSQL_AUTH_TOKEN"] = originalLibsqlAuthToken
    }

    if (originalTursoAuthToken === undefined) {
      delete process.env["TURSO_AUTH_TOKEN"]
    } else {
      process.env["TURSO_AUTH_TOKEN"] = originalTursoAuthToken
    }

    if (originalTursoApiToken === undefined) {
      delete process.env["TURSO_API_TOKEN"]
    } else {
      process.env["TURSO_API_TOKEN"] = originalTursoApiToken
    }
  })

  it("shows a clear error when required shell options are missing", async () => {
    const result = await runPfcliInProcess(["db", "shell"])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing required database shell option(s)")
    expect(output).toContain("--project")
    expect(output).toContain("--env")
  })

  it("preflights the external Turso CLI before requesting a shell session", async () => {
    let fetchCalled = false
    let spawnCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch

    const result = await Effect.runPromiseExit(
      runDatabaseShell("0000-0000-0001", "dev", undefined, {
        findExecutable: () => undefined,
        spawn: () => {
          spawnCalled = true
          return { exited: Promise.resolve(0) }
        },
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toContain("Turso CLI")
    expect(fetchCalled).toBe(false)
    expect(spawnCalled).toBe(false)
  })

  it("passes parsed TTL to GraphQL, warns without leaking the token, and launches Turso", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-shell-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    process.env["LIBSQL_AUTH_TOKEN"] = "ambient-libsql-token"
    process.env["TURSO_AUTH_TOKEN"] = "ambient-turso-token"
    process.env["TURSO_API_TOKEN"] = "ambient-turso-api-token"

    let graphqlCalled = false
    let spawnCalled = false
    let spawnedCommand: readonly string[] = []
    let spawnedOptions:
      | {
          readonly stdin: "inherit"
          readonly stdout: "inherit"
          readonly stderr: "inherit"
          readonly env: Record<string, string | undefined>
        }
      | undefined

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = readGraphqlBody(init)
      if (body.query.includes("createDatabaseShellSession")) {
        graphqlCalled = true
        expect(body.variables).toEqual({
          projectId: "0000-0000-0001",
          environmentId: "dev",
          ttlSeconds: 900,
        })
        return graphqlResponse({
          createDatabaseShellSession: {
            databaseUrl: "libsql://database.example.turso.io/",
            authToken: "secret-shell-token",
            expiresAt: "2026-05-19T12:15:00.000Z",
            databaseName: "pf-0000-0000-0001-dev-example",
          },
        })
      }

      throw new Error(`Unexpected GraphQL operation: ${body.query}`)
    }) as unknown as typeof fetch

    const { output: terminalOutput, result } = await captureTerminalOutput(
      async () =>
        Effect.runPromise(
          runDatabaseShell("0000-0000-0001", "dev", "15m", {
            findExecutable: (command) =>
              command === "turso" ? "/usr/local/bin/turso" : undefined,
            spawn: (command, options) => {
              spawnCalled = true
              spawnedCommand = command
              spawnedOptions = options
              return { exited: Promise.resolve(7) }
            },
          }),
        ),
    )

    expect(result).toBe(7)
    expect(graphqlCalled).toBe(true)
    expect(spawnCalled).toBe(true)
    expect(spawnedCommand.slice(0, 3)).toEqual([
      "/usr/local/bin/turso",
      "db",
      "shell",
    ])
    expect(spawnedCommand).toHaveLength(4)
    const shellTarget = spawnedCommand[3]
    expect(shellTarget).toBe(
      "https://database.example.turso.io?authToken=secret-shell-token",
    )
    expect(new URL(shellTarget ?? "").searchParams.get("authToken")).toBe(
      "secret-shell-token",
    )
    expect(spawnedOptions?.stdin).toBe("inherit")
    expect(spawnedOptions?.stdout).toBe("inherit")
    expect(spawnedOptions?.stderr).toBe("inherit")
    expect(spawnedOptions?.env["LIBSQL_AUTH_TOKEN"]).toBeUndefined()
    expect(spawnedOptions?.env["TURSO_AUTH_TOKEN"]).toBeUndefined()
    expect(spawnedOptions?.env["TURSO_API_TOKEN"]).toBeUndefined()
    expect(terminalOutput).toContain("read-write Database Shell session")
    expect(terminalOutput).toContain("0000-0000-0001")
    expect(terminalOutput).toContain("dev")
    expect(terminalOutput).toContain("pf-0000-0000-0001-dev-example")
    expect(terminalOutput).toContain("local process listings may expose it")
    expect(terminalOutput).toContain(
      new Date("2026-05-19T12:15:00.000Z").toLocaleString(),
    )
    expect(terminalOutput).not.toContain("secret-shell-token")
    expect(terminalOutput).not.toContain("authToken")
    expect(terminalOutput).not.toContain("libsql://database.example.turso.io")
    expect(terminalOutput).not.toContain("https://database.example.turso.io")
  })

  it("omits ttlSeconds when no TTL is provided", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-shell-default-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = readGraphqlBody(init)
      expect(body.variables).toEqual({
        projectId: "0000-0000-0001",
        environmentId: "dev",
      })
      return graphqlResponse({
        createDatabaseShellSession: {
          databaseUrl: "libsql://database.example.turso.io",
          authToken: "secret-shell-token",
          expiresAt: "2026-05-19T12:15:00.000Z",
          databaseName: "pf-0000-0000-0001-dev-example",
        },
      })
    }) as unknown as typeof fetch

    const { result } = await captureTerminalOutput(async () =>
      Effect.runPromise(
        runDatabaseShell("0000-0000-0001", "dev", undefined, {
          findExecutable: () => "/usr/local/bin/turso",
          spawn: () => ({ exited: Promise.resolve(0) }),
        }),
      ),
    )

    expect(result).toBe(0)
  })

  it.each([
    "https://database.example.turso.io",
    "libsql://database.example.turso.io/tenant",
    "libsql://user:password@database.example.turso.io",
    "libsql://database.example.turso.io#fragment",
  ])(
    "rejects unsupported shell session URL %s before launching Turso",
    async (databaseUrl) => {
      const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-shell-invalid-url-"))
      tempPaths.push(testDir)
      process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
        testDir,
        "https://console.example.test",
      )
      let spawnCalled = false

      globalThis.fetch = (async () =>
        graphqlResponse({
          createDatabaseShellSession: {
            databaseUrl,
            authToken: "secret-shell-token",
            expiresAt: "2026-05-19T12:15:00.000Z",
            databaseName: "pf-0000-0000-0001-dev-example",
          },
        })) as unknown as typeof fetch

      const { result } = await captureTerminalOutput(async () =>
        Effect.runPromiseExit(
          runDatabaseShell("0000-0000-0001", "dev", undefined, {
            findExecutable: () => "/usr/local/bin/turso",
            spawn: () => {
              spawnCalled = true
              return { exited: Promise.resolve(0) }
            },
          }),
        ),
      )

      expect(result._tag).toBe("Failure")
      expect(getFailureMessage(result)).toContain("invalid database URL")
      expect(spawnCalled).toBe(false)
    },
  )

  it("surfaces GraphQL errors before launching Turso", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-shell-graphql-error-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    let spawnCalled = false

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "database access denied" }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )) as unknown as typeof fetch

    const result = await Effect.runPromiseExit(
      runDatabaseShell("0000-0000-0001", "dev", undefined, {
        findExecutable: () => "/usr/local/bin/turso",
        spawn: () => {
          spawnCalled = true
          return { exited: Promise.resolve(0) }
        },
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toContain(
      "GraphQL error: database access denied",
    )
    expect(spawnCalled).toBe(false)
  })

  it("rejects invalid TTL before requesting a shell session", async () => {
    let fetchCalled = false
    let spawnCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch

    const result = await Effect.runPromiseExit(
      runDatabaseShell("0000-0000-0001", "dev", "1d", {
        findExecutable: () => "/usr/local/bin/turso",
        spawn: () => {
          spawnCalled = true
          return { exited: Promise.resolve(0) }
        },
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toContain("TTL unit")
    expect(fetchCalled).toBe(false)
    expect(spawnCalled).toBe(false)
  })

  it("rejects zero TTL before requesting a shell session", async () => {
    let fetchCalled = false
    let spawnCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch

    const result = await Effect.runPromiseExit(
      runDatabaseShell("0000-0000-0001", "dev", "0s", {
        findExecutable: () => "/usr/local/bin/turso",
        spawn: () => {
          spawnCalled = true
          return { exited: Promise.resolve(0) }
        },
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toContain("positive whole number")
    expect(fetchCalled).toBe(false)
    expect(spawnCalled).toBe(false)
  })

  it("accepts the maximum TTL value", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-shell-max-ttl-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = readGraphqlBody(init)
      expect(body.variables).toEqual({
        projectId: "0000-0000-0001",
        environmentId: "dev",
        ttlSeconds: 3600,
      })
      return graphqlResponse({
        createDatabaseShellSession: {
          databaseUrl: "libsql://database.example.turso.io",
          authToken: "secret-shell-token",
          expiresAt: "2026-05-19T12:15:00.000Z",
          databaseName: "pf-0000-0000-0001-dev-example",
        },
      })
    }) as unknown as typeof fetch

    const { result } = await captureTerminalOutput(async () =>
      Effect.runPromise(
        runDatabaseShell("0000-0000-0001", "dev", "1h", {
          findExecutable: () => "/usr/local/bin/turso",
          spawn: () => ({ exited: Promise.resolve(0) }),
        }),
      ),
    )

    expect(result).toBe(0)
  })

  it("rejects TTL values above 1 hour before requesting a shell session", async () => {
    let fetchCalled = false
    let spawnCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch

    const result = await Effect.runPromiseExit(
      runDatabaseShell("0000-0000-0001", "dev", "3601s", {
        findExecutable: () => "/usr/local/bin/turso",
        spawn: () => {
          spawnCalled = true
          return { exited: Promise.resolve(0) }
        },
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toContain("1 hour or less")
    expect(fetchCalled).toBe(false)
    expect(spawnCalled).toBe(false)
  })
})
