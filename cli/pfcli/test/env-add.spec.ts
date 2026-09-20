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

type CreateExecutionEventSource =
  typeof import("../src/utils/execution-subscription").createExecutionEventSource

useSerializedTestState()

type ExecutionEventSourceConfig = Parameters<CreateExecutionEventSource>[0]

type EnvAddRequestBody = {
  readonly query: string
  readonly variables?: Record<string, string>
}

type MockFetchOptions = {
  readonly subscriptionKind: ExecutionEventSourceConfig["kind"]
  readonly appSyncEventsHttpHost?: string | null
  readonly onStartAddEnvironment?: (body: EnvAddRequestBody) => void
}

type RunEnvAdd = (
  projectId: string,
  stageId: string,
  environmentName: string,
  dependencies?: {
    createExecutionEventSource?: CreateExecutionEventSource
  },
) => Effect.Effect<void, unknown>

const loadRunEnvAdd = async (): Promise<RunEnvAdd> => {
  const module = await loadPfcliCommand<{
    runEnvAdd: RunEnvAdd
  }>("env/add")

  return module.runEnvAdd
}

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

const isCliError = (
  value: unknown,
): value is { _tag: string; message: string } =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  "message" in value

const createJsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const createMockFetch = ({
  subscriptionKind,
  appSyncEventsHttpHost,
  onStartAddEnvironment,
}: MockFetchOptions): typeof fetch =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as EnvAddRequestBody

    if (body.query.includes("subscriptionTransport")) {
      return createJsonResponse({
        subscriptionTransport: {
          kind: subscriptionKind,
          appSyncEventsHttpHost: appSyncEventsHttpHost ?? null,
        },
      })
    }

    if (body.query.includes("startOperationsAddEnvironment")) {
      onStartAddEnvironment?.(body)

      return createJsonResponse({
        startOperationsAddEnvironment: {
          executionId: "exec-1",
          processPath: "operations/add-environment",
        },
      })
    }

    return new Response("not-found", { status: 404 })
  }) as unknown as typeof fetch

describe("pfcli env add", () => {
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

  it("starts the generated add-environment mutation, waits for completion, and prints the created environment name", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-add-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    let eventSourceCreated = false
    let eventSourceClosed = false
    let sawRunningSnapshot = false

    globalThis.fetch = createMockFetch({
      subscriptionKind: "GRAPHQL_WS",
      onStartAddEnvironment: (body) => {
        expect(eventSourceCreated).toBe(true)
        expect(body.variables).toEqual({
          projectId: "project-123",
          stageId: "Production",
          environmentName: "prd",
        })
      },
    })

    const runEnvAdd = await loadRunEnvAdd()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runEnvAdd("project-123", "Production", "prd", {
          createExecutionEventSource: () =>
            Effect.sync(() => {
              eventSourceCreated = true
              return {
                close: async () => {
                  eventSourceClosed = true
                },
                async *[Symbol.asyncIterator]() {
                  yield {
                    id: "other-execution",
                    status: "Running",
                    failureReason: null,
                    abandonedReason: null,
                    finishedAt: null,
                    steps: [],
                  }
                  yield {
                    id: "exec-1",
                    status: "Running",
                    failureReason: null,
                    abandonedReason: null,
                    finishedAt: null,
                    steps: [
                      {
                        name: "Save environment to database",
                        path: "/operations/add-environment/save-environment",
                        status: "Waiting",
                        failureReason: null,
                      },
                    ],
                  }
                  sawRunningSnapshot = true
                  yield {
                    id: "exec-1",
                    status: "Completed",
                    failureReason: null,
                    abandonedReason: null,
                    finishedAt: new Date().toISOString(),
                    steps: [
                      {
                        name: "Save environment to database",
                        path: "/operations/add-environment/save-environment",
                        status: "Completed",
                        failureReason: null,
                      },
                    ],
                  }
                },
              }
            }),
        }),
      ),
    )

    expect(sawRunningSnapshot).toBe(true)
    expect(eventSourceClosed).toBe(true)
    expect(output).toContain('"message":"Environment add started"')
    expect(output).toContain('"executionId":"exec-1"')
    expect(output).toContain("Waiting for environment creation to complete...")
    expect(output).toContain("Environment created: prd")
  })

  it("uses AppSync execution subscriptions when the console requests them", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-add-test-"))
    tempPaths.push(testDir)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: { userId: "user-123" },
    })

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )

    let capturedConfig: ExecutionEventSourceConfig | undefined

    globalThis.fetch = createMockFetch({
      subscriptionKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    const runEnvAdd = await loadRunEnvAdd()
    await captureStdout(() =>
      Effect.runPromise(
        runEnvAdd("project-123", "Production", "prd", {
          createExecutionEventSource: (config: ExecutionEventSourceConfig) => {
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
        }),
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

  it("requires --stage on the CLI", async () => {
    const result = await runPfcliInProcess([
      "env",
      "add",
      "--project",
      "project-123",
      "prd",
    ])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("--stage")
  })

  it("propagates backend validation failures for invalid environment names without local mirror validation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-add-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    globalThis.fetch = createMockFetch({
      subscriptionKind: "GRAPHQL_WS",
      onStartAddEnvironment: (body) => {
        expect(body.variables).toEqual({
          projectId: "project-123",
          stageId: "Production",
          environmentName: "Prod",
        })
      },
    })

    const runEnvAdd = await loadRunEnvAdd()
    const { result: error } = await captureStdout(() =>
      Effect.runPromise(
        runEnvAdd("project-123", "Production", "Prod", {
          createExecutionEventSource: () =>
            Effect.succeed({
              close: async () => undefined,
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "exec-1",
                  status: "Failed",
                  failureReason:
                    "InputValidationError: environmentName: Environment name must be 1-5 lowercase alphanumeric characters and unique within the project",
                  abandonedReason: null,
                  finishedAt: new Date().toISOString(),
                  steps: [],
                }
              },
            }),
        }).pipe(Effect.flip),
      ),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toContain("InputValidationError")
      expect(error.message).toContain("environmentName")
      expect(error.message).toContain("lowercase alphanumeric")
    }
  })

  it("propagates backend stage resolution failures", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-env-add-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    globalThis.fetch = createMockFetch({
      subscriptionKind: "GRAPHQL_WS",
      onStartAddEnvironment: (body) => {
        expect(body.variables).toEqual({
          projectId: "project-123",
          stageId: "Missing",
          environmentName: "prd",
        })
      },
    })

    const runEnvAdd = await loadRunEnvAdd()
    const { result: error } = await captureStdout(() =>
      Effect.runPromise(
        runEnvAdd("project-123", "Missing", "prd", {
          createExecutionEventSource: () =>
            Effect.succeed({
              close: async () => undefined,
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "exec-1",
                  status: "Failed",
                  failureReason: null,
                  abandonedReason: null,
                  finishedAt: new Date().toISOString(),
                  steps: [
                    {
                      name: "Save environment to database",
                      path: "/operations/add-environment/save-environment",
                      status: "Failed",
                      failureReason:
                        "Caused by: [ValidationError] Stage not found in project: Missing",
                    },
                  ],
                }
              },
            }),
        }).pipe(Effect.flip),
      ),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toContain("Stage not found in project: Missing")
    }
  })
})
