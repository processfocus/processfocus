import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { runPfcliInProcess, useSerializedTestState } from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")

useSerializedTestState()

interface ExecutionSnapshot {
  readonly id: string
  readonly status: string
  readonly failureReason: string | null
  readonly abandonedReason: string | null
  readonly finishedAt: string | null
  readonly steps: unknown[]
}

interface ExecutionEventSource extends AsyncIterable<ExecutionSnapshot> {
  readonly close: () => void | Promise<void>
}

interface ExecutionEventSourceConfig {
  readonly kind: string
  readonly wsEndpoint?: string
  readonly realtimeUrl?: string
  readonly appSyncEventsHttpHost?: string
  readonly accessToken: string
  readonly userId?: string
}

type RunRollbackDb = (
  projectId: string,
  environmentId: string,
  timestamp: string,
  options?: { waitForCompletion?: boolean },
  dependencies?: {
    createExecutionEventSource?: (
      config: ExecutionEventSourceConfig,
    ) => Effect.Effect<ExecutionEventSource>
  },
) => Effect.Effect<unknown>

const loadRunRollbackDb = async (): Promise<RunRollbackDb> => {
  const modulePath = join(
    WORKSPACE_ROOT,
    "cli/pfcli/src/commands/db/rollback.ts",
  )
  const module = (await import(modulePath)) as {
    runRollbackDb: RunRollbackDb
  }
  return module.runRollbackDb
}

const runRollbackDbEffect = async (
  projectId: string,
  environmentId: string,
  timestamp: string,
  options?: { waitForCompletion?: boolean },
  dependencies?: Parameters<RunRollbackDb>[4],
): Promise<Effect.Effect<unknown>> =>
  (await loadRunRollbackDb())(
    projectId,
    environmentId,
    timestamp,
    options,
    dependencies,
  )

const createCredentialsFile = (
  baseDir: string,
  baseUrl: string,
  expiresAt: string,
  accessToken = "test-token",
) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl,
        accessToken,
        expiresAt,
        loginAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  return credentialsPath
}

const createJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`
}

describe("pfcli db rollback", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  afterEach(() => {
    for (const p of tempPaths) {
      rmSync(p, { recursive: true, force: true })
    }
    tempPaths.length = 0
    globalThis.fetch = originalFetch

    if (originalCredPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
    }
  })

  it("shows a clear error when required rollback options are missing", async () => {
    const result = await runPfcliInProcess(["db", "rollback"])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing required rollback option(s)")
    expect(output).toContain("--project")
    expect(output).toContain("--env")
    expect(output).toContain("--timestamp")
  })

  it("documents local-time timestamps in rollback help", async () => {
    const result = await runPfcliInProcess(["db", "rollback", "--help"])

    expect(result.status).toBe(0)
    const output = result.output
    expect(output).toContain(
      "if no timezone is supplied, the local terminal timezone is used",
    )
    expect(output).toContain("2026-04-16T18:00:00")
  })

  it("starts the generated rollback mutation without waiting when requested", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-rollback-test-"))
    tempPaths.push(testDir)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath

    let startCalled = false
    let transportCalled = false

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: Record<string, string>
      }

      if (body.query.includes("subscriptionTransport")) {
        transportCalled = true
      }

      if (body.query.includes("startOperationsRollbackDb")) {
        startCalled = true
        expect(body.variables).toEqual({
          projectId: "project-123",
          environmentId: "env-456",
          timestamp: "2026-04-01T00:00:00Z",
        })

        return new Response(
          JSON.stringify({
            data: {
              startOperationsRollbackDb: {
                executionId: "exec-1",
                processPath: "operations/rollback-db",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response("not-found", { status: 404 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      await runRollbackDbEffect(
        "project-123",
        "env-456",
        "2026-04-01T00:00:00Z",
        { waitForCompletion: false },
        {
          createExecutionEventSource: () => {
            throw new Error(
              "rollback should not subscribe when --no-wait is set",
            )
          },
        },
      ),
    )

    expect(startCalled).toBe(true)
    expect(transportCalled).toBe(false)
  })

  it("waits for completion by default and subscribes before starting rollback", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-rollback-test-"))
    tempPaths.push(testDir)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath

    let eventSourceCreated = false
    let eventSourceClosed = false
    let startCalled = false

    const snapshots: ExecutionSnapshot[] = [
      {
        id: "other-execution",
        status: "Running",
        failureReason: null,
        abandonedReason: null,
        finishedAt: null,
        steps: [],
      },
      {
        id: "exec-1",
        status: "Running",
        failureReason: null,
        abandonedReason: null,
        finishedAt: null,
        steps: [
          {
            name: "Run rollback preflight",
            path: "/rollback",
            status: "Waiting",
            failureReason: null,
          },
        ],
      },
      {
        id: "exec-1",
        status: "Completed",
        failureReason: null,
        abandonedReason: null,
        finishedAt: new Date().toISOString(),
        steps: [
          {
            name: "Run rollback preflight",
            path: "/rollback",
            status: "Completed",
            failureReason: null,
          },
        ],
      },
    ]

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes("subscriptionTransport")) {
        return new Response(
          JSON.stringify({
            data: {
              subscriptionTransport: {
                kind: "GRAPHQL_WS",
                appSyncEventsHttpHost: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      if (body.query.includes("startOperationsRollbackDb")) {
        startCalled = true
        expect(eventSourceCreated).toBe(true)
        return new Response(
          JSON.stringify({
            data: {
              startOperationsRollbackDb: {
                executionId: "exec-1",
                processPath: "operations/rollback-db",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response("not-found", { status: 404 })
    }) as unknown as typeof fetch

    const fakeEventSource: ExecutionEventSource = {
      close: async () => {
        eventSourceClosed = true
      },
      async *[Symbol.asyncIterator]() {
        for (const snapshot of snapshots) {
          yield snapshot
        }
      },
    }

    await Effect.runPromise(
      await runRollbackDbEffect(
        "project-123",
        "env-456",
        "2026-04-01T00:00:00Z",
        undefined,
        {
          createExecutionEventSource: () =>
            Effect.sync(() => {
              eventSourceCreated = true
              return fakeEventSource
            }),
        },
      ),
    )

    expect(startCalled).toBe(true)
    expect(eventSourceClosed).toBe(true)
  })

  it("uses AppSync execution subscriptions when the console requests them", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-rollback-test-"))
    tempPaths.push(testDir)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: { userId: "user-123" },
    })
    const credentialsPath = createCredentialsFile(
      testDir,
      "https://console.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath

    let capturedConfig: ExecutionEventSourceConfig | undefined

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes("subscriptionTransport")) {
        return new Response(
          JSON.stringify({
            data: {
              subscriptionTransport: {
                kind: "APPSYNC_EVENTS",
                appSyncEventsHttpHost:
                  "abc123.appsync-api.us-west-2.amazonaws.com",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      if (body.query.includes("startOperationsRollbackDb")) {
        return new Response(
          JSON.stringify({
            data: {
              startOperationsRollbackDb: {
                executionId: "exec-1",
                processPath: "operations/rollback-db",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response("not-found", { status: 404 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      await runRollbackDbEffect(
        "project-123",
        "env-456",
        "2026-04-01T00:00:00Z",
        undefined,
        {
          createExecutionEventSource: (config) => {
            capturedConfig = config
            return Effect.succeed({
              close: async () => undefined,
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "exec-1",
                  status: "Completed",
                  failureReason: null,
                  abandonedReason: null,
                  finishedAt: new Date().toISOString(),
                  steps: [],
                }
              },
            })
          },
        },
      ),
    )

    expect(capturedConfig).toEqual(
      expect.objectContaining({
        kind: "APPSYNC_EVENTS",
        appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
        userId: "user-123",
      }),
    )
  })
})
