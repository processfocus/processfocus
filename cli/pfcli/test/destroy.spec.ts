import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type {
  ExecutionEventSource,
  ExecutionSnapshot,
} from "../src/utils/execution-subscription"
import {
  captureStdout,
  loadPfcliCommand,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

type CreateExecutionEventSource =
  typeof import("../src/utils/execution-subscription").createExecutionEventSource

type RunDestroy = (
  projectId: string,
  environmentId: string,
  options?: { readonly waitForCompletion?: boolean },
  dependencies?: {
    readonly createExecutionEventSource?: CreateExecutionEventSource
  },
) => Effect.Effect<void, unknown>

type GraphqlRequestBody = {
  readonly query: string
  readonly variables?: Record<string, string>
}

const loadRunDestroy = async (): Promise<RunDestroy> => {
  const module = await loadPfcliCommand<{ runDestroy: RunDestroy }>("destroy")
  return module.runDestroy
}

const createCredentialsFile = (baseDir: string) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      version: 1,
      baseUrl: "http://mocked.test",
      accessToken: "test-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      loginAt: new Date().toISOString(),
    }),
  )
  return credentialsPath
}

const jsonResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const completedExecution = (executionId = "exec-destroy-1") =>
  ({
    id: executionId,
    status: "Completed",
    failureReason: null,
    abandonedReason: null,
    finishedAt: new Date().toISOString(),
    steps: [],
  }) satisfies ExecutionSnapshot

const createEventSource = (
  snapshots: readonly ExecutionSnapshot[],
  onClose: () => void = () => undefined,
): ExecutionEventSource => ({
  close: async () => {
    onClose()
  },
  async *[Symbol.asyncIterator]() {
    for (const snapshot of snapshots) {
      yield snapshot
    }
  },
})

useSerializedTestState()

describe("pfcli destroy", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  const useTestCredentials = () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-destroy-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(testDir)
  }

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

  it("documents all destructive command options", async () => {
    const result = await runPfcliInProcess(["destroy", "--help"])

    expect(result.status).toBe(0)
    expect(result.output).toContain("--project")
    expect(result.output).toContain("--env")
    expect(result.output).toContain("--yes")
    expect(result.output).toContain("--no-wait")
  })

  it("reports missing project and environment options without an Effect dump", async () => {
    const result = await runPfcliInProcess(["destroy"])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("Missing required destroy option(s)")
    expect(result.output).toContain("--project")
    expect(result.output).toContain("--env")
    expect(result.output).toContain("pfcli destroy --project")
    expect(result.output).not.toContain("_tag")
  })

  it("requires --yes before making any GraphQL request", async () => {
    useTestCredentials()
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error("GraphQL must not be called without --yes")
    }) as unknown as typeof fetch

    const result = await runPfcliInProcess([
      "destroy",
      "--project",
      "4800-6993-9756",
      "--env",
      "dbup1",
    ])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("project 4800-6993-9756")
    expect(result.output).toContain("environment dbup1")
    expect(result.output).toContain("deletes the environment's AWS stacks")
    expect(result.output).toContain("environment record")
    expect(result.output).toContain("--yes")
    expect(fetchCalls).toBe(0)
  })

  it("tells unauthenticated users to run pfcli auth login", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-destroy-test-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = join(testDir, "missing.json")

    const result = await runPfcliInProcess([
      "destroy",
      "--project",
      "4800-6993-9756",
      "--env",
      "dbup1",
      "--yes",
    ])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Run "pfcli auth login"')
  })

  it("rejects an unknown environment before starting destruction", async () => {
    useTestCredentials()
    let startCalled = false
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as GraphqlRequestBody
      if (body.query.includes("listProjectEnvironments")) {
        return jsonResponse({
          listProjectEnvironments: {
            items: [{ environmentName: "prod" }],
          },
        })
      }
      if (body.query.includes("startOperationsDestroyEnvironment")) {
        startCalled = true
      }
      return new Response("not-found", { status: 404 })
    }) as typeof fetch

    const runDestroy = await loadRunDestroy()
    const error = await Effect.runPromise(
      runDestroy("4800-6993-9756", "dbup1", {
        waitForCompletion: false,
      }).pipe(Effect.flip),
    )

    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Unknown environment "dbup1"'),
      }),
    )
    expect(startCalled).toBe(false)
  })

  it("starts the destroy mutation and returns without subscribing for --no-wait", async () => {
    useTestCredentials()
    const internalEnvironmentId = "env-01M1B76K5PMMAT9K0X8P4NHMZD"
    let transportCalled = false
    let eventSourceCreated = false
    let capturedStartBody: GraphqlRequestBody | undefined

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as GraphqlRequestBody
      if (body.query.includes("listProjectEnvironments")) {
        return jsonResponse({
          listProjectEnvironments: {
            items: [{ environmentName: "dbup1" }],
          },
        })
      }
      if (body.query.includes("subscriptionTransport")) {
        transportCalled = true
      }
      if (body.query.includes("startOperationsDestroyEnvironment")) {
        capturedStartBody = body
        return jsonResponse({
          startOperationsDestroyEnvironment: {
            executionId: "exec-destroy-1",
            processPath: "operations/destroy-environment",
          },
        })
      }
      return new Response("not-found", { status: 404 })
    }) as typeof fetch

    const runDestroy = await loadRunDestroy()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runDestroy(
          "4800-6993-9756",
          internalEnvironmentId,
          { waitForCompletion: false },
          {
            createExecutionEventSource: () => {
              eventSourceCreated = true
              return Effect.succeed(createEventSource([]))
            },
          },
        ),
      ),
    )

    expect(capturedStartBody?.variables).toEqual({
      projectId: "4800-6993-9756",
      environmentId: internalEnvironmentId,
    })
    expect(capturedStartBody?.query).toContain(
      "mutation StartDestroyEnvironment",
    )
    expect(output).toContain('"message":"Destroy started"')
    expect(output).toContain('"executionId":"exec-destroy-1"')
    expect(transportCalled).toBe(false)
    expect(eventSourceCreated).toBe(false)
  })

  it("subscribes before starting and waits until destruction completes", async () => {
    useTestCredentials()
    let eventSourceCreated = false
    let eventSourceClosed = false

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as GraphqlRequestBody
      if (body.query.includes("listProjectEnvironments")) {
        return jsonResponse({
          listProjectEnvironments: {
            items: [{ environmentName: "dbup1" }],
          },
        })
      }
      if (body.query.includes("subscriptionTransport")) {
        return jsonResponse({
          subscriptionTransport: {
            kind: "GRAPHQL_WS",
            appSyncEventsHttpHost: null,
          },
        })
      }
      if (body.query.includes("startOperationsDestroyEnvironment")) {
        expect(eventSourceCreated).toBe(true)
        return jsonResponse({
          startOperationsDestroyEnvironment: {
            executionId: "exec-destroy-1",
            processPath: "operations/destroy-environment",
          },
        })
      }
      return new Response("not-found", { status: 404 })
    }) as typeof fetch

    const runDestroy = await loadRunDestroy()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runDestroy("4800-6993-9756", "dbup1", undefined, {
          createExecutionEventSource: () =>
            Effect.sync(() => {
              eventSourceCreated = true
              return createEventSource([completedExecution()], () => {
                eventSourceClosed = true
              })
            }),
        }),
      ),
    )

    expect(eventSourceClosed).toBe(true)
    expect(output).toContain("Waiting for environment destruction")
    expect(output).toContain("Environment destroyed: dbup1")
  })

  for (const terminal of [
    {
      status: "Failed",
      failureReason: "CloudFormation stack deletion failed",
      abandonedReason: null,
    },
    {
      status: "Abandoned",
      failureReason: null,
      abandonedReason: "Destroy cancelled by operator",
    },
  ] as const) {
    it(`surfaces the execution failure message for ${terminal.status}`, async () => {
      useTestCredentials()

      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as GraphqlRequestBody
        if (body.query.includes("listProjectEnvironments")) {
          return jsonResponse({
            listProjectEnvironments: {
              items: [{ environmentName: "dbup1" }],
            },
          })
        }
        if (body.query.includes("subscriptionTransport")) {
          return jsonResponse({
            subscriptionTransport: {
              kind: "GRAPHQL_WS",
              appSyncEventsHttpHost: null,
            },
          })
        }
        if (body.query.includes("startOperationsDestroyEnvironment")) {
          return jsonResponse({
            startOperationsDestroyEnvironment: {
              executionId: "exec-destroy-1",
              processPath: "operations/destroy-environment",
            },
          })
        }
        return new Response("not-found", { status: 404 })
      }) as typeof fetch

      const terminalExecution = {
        id: "exec-destroy-1",
        status: terminal.status,
        failureReason: terminal.failureReason,
        abandonedReason: terminal.abandonedReason,
        finishedAt: new Date().toISOString(),
        steps: [],
      } satisfies ExecutionSnapshot
      const runDestroy = await loadRunDestroy()
      const { result: error } = await captureStdout(() =>
        Effect.runPromise(
          runDestroy("4800-6993-9756", "dbup1", undefined, {
            createExecutionEventSource: () =>
              Effect.succeed(createEventSource([terminalExecution])),
          }).pipe(Effect.flip),
        ),
      )

      expect(error).toEqual(
        expect.objectContaining({
          message: terminal.failureReason ?? terminal.abandonedReason,
        }),
      )
    })
  }
})
