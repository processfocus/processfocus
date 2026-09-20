import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

type CreateExecutionEventSource =
  typeof import("../src/utils/execution-subscription").createExecutionEventSource

useSerializedTestState()

type ExecutionEventSourceConfig = Parameters<CreateExecutionEventSource>[0]

type StageAddRequestBody = {
  readonly query: string
  readonly variables?: Record<string, string>
}

type MockFetchOptions = {
  readonly subscriptionKind: ExecutionEventSourceConfig["kind"]
  readonly appSyncEventsHttpHost?: string | null
  readonly onStartAddStage?: (body: StageAddRequestBody) => void
}

type RunStageAdd = (
  projectId: string,
  stageName: string,
  dependencies?: {
    createExecutionEventSource?: CreateExecutionEventSource
  },
) => Effect.Effect<void, unknown>

const loadRunStageAdd = async (): Promise<RunStageAdd> => {
  const module = await loadPfcliCommand<{
    runStageAdd: RunStageAdd
  }>("stage/add")

  return module.runStageAdd
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
  onStartAddStage,
}: MockFetchOptions): typeof fetch =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as StageAddRequestBody

    if (body.query.includes("subscriptionTransport")) {
      return createJsonResponse({
        subscriptionTransport: {
          kind: subscriptionKind,
          appSyncEventsHttpHost: appSyncEventsHttpHost ?? null,
        },
      })
    }

    if (body.query.includes("startOperationsAddStage")) {
      onStartAddStage?.(body)

      return createJsonResponse({
        startOperationsAddStage: {
          executionId: "exec-1",
          processPath: "operations/add-stage",
        },
      })
    }

    return new Response("not-found", { status: 404 })
  }) as unknown as typeof fetch

describe("pfcli stage add", () => {
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

  it("starts the generated add-stage mutation, waits for completion, and prints the created stage name", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-add-test-"))
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
      onStartAddStage: (body) => {
        expect(eventSourceCreated).toBe(true)
        expect(body.variables).toEqual({
          projectId: "project-123",
          stageName: "Production",
        })
      },
    })

    const runStageAdd = await loadRunStageAdd()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runStageAdd("project-123", "Production", {
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
                        name: "Save stage to database",
                        path: "/operations/add-stage/save-stage",
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
                        name: "Save stage to database",
                        path: "/operations/add-stage/save-stage",
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
    expect(output).toContain('"message":"Stage add started"')
    expect(output).toContain('"executionId":"exec-1"')
    expect(output).toContain("Waiting for stage creation to complete...")
    expect(output).toContain("Stage created: Production")
  })

  it("uses AppSync execution subscriptions when the console requests them", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-add-test-"))
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

    const runStageAdd = await loadRunStageAdd()
    await captureStdout(() =>
      Effect.runPromise(
        runStageAdd("project-123", "Production", {
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

  it("normalizes duplicate stage failures into a clean message", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-add-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    globalThis.fetch = createMockFetch({ subscriptionKind: "GRAPHQL_WS" })

    const runStageAdd = await loadRunStageAdd()
    const { result: error } = await captureStdout(() =>
      Effect.runPromise(
        runStageAdd("project-123", "Production", {
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
                      name: "Save stage to database",
                      path: "/operations/add-stage/save-stage",
                      status: "Failed",
                      failureReason:
                        'Caused by: [ValidationError] Stage "Production" already exists in this project.',
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
      expect(error._tag).toBe("CliError")
      expect(error.message).toBe(
        'Stage "Production" already exists in this project.',
      )
    }
  })

  it("propagates backend validation failures without local mirror validation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-stage-add-test-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )

    globalThis.fetch = createMockFetch({
      subscriptionKind: "GRAPHQL_WS",
      onStartAddStage: (body) => {
        expect(body.variables).toEqual({
          projectId: "project-123",
          stageName: "prod/v2",
        })
      },
    })

    const runStageAdd = await loadRunStageAdd()
    const { result: error } = await captureStdout(() =>
      Effect.runPromise(
        runStageAdd("project-123", "prod/v2", {
          createExecutionEventSource: () =>
            Effect.succeed({
              close: async () => undefined,
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "exec-1",
                  status: "Failed",
                  failureReason:
                    "InputValidationError: stageName: Stage name is required (max 256 characters), cannot contain slashes",
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
      expect(error.message).toContain("stageName")
      expect(error.message).toContain("cannot contain slashes")
    }
  })
})
