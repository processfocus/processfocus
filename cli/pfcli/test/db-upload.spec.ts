import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { runUploadDb } from "../src/commands/db/upload"
import type { ExecutionSnapshot } from "../src/utils/execution-subscription"
import {
  captureStdout,
  getFailureMessage,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const SQLITE_BYTES = Buffer.concat([
  Buffer.from("SQLite format 3\u0000", "binary"),
  Buffer.from("test-db-bytes"),
])

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

const createExecutionEventSource = (snapshot: ExecutionSnapshot) => () =>
  Effect.succeed({
    close: async () => undefined,
    async *[Symbol.asyncIterator]() {
      yield snapshot
    },
  })

const completedExecution = (executionId: string): ExecutionSnapshot => ({
  id: executionId,
  status: "Completed",
  failureReason: null,
  abandonedReason: null,
  finishedAt: new Date().toISOString(),
  steps: [],
})

const failedExecution = (executionId: string): ExecutionSnapshot => ({
  id: executionId,
  status: "Failed",
  failureReason: "backend rejected database artifact",
  abandonedReason: null,
  finishedAt: new Date().toISOString(),
  steps: [],
})

const graphqlResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const unexpectedGraphqlOperation = (query: string): never => {
  throw new Error(`Unexpected GraphQL operation: ${query}`)
}

const readGraphqlBody = (init?: RequestInit) =>
  JSON.parse(String(init?.body)) as {
    query: string
    variables: Record<string, unknown>
  }

describe("pfcli db upload", () => {
  const tempPaths: string[] = []
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalFetch = globalThis.fetch

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
  })

  it("shows a clear error when required upload options and file are missing", async () => {
    const result = await runPfcliInProcess(["db", "upload"])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing required upload option(s)")
    expect(output).toContain("--project")
    expect(output).toContain("--env")
    expect(output).toContain("<sqlite-file>")
  })

  it("does not expose a no-wait option", async () => {
    const result = await runPfcliInProcess(["db", "upload", "--help"])

    expect(result.status).toBe(0)
    expect(result.output).not.toContain("--no-wait")
  })

  it("rejects an unknown upload mode before running the command", async () => {
    const result = await runPfcliInProcess([
      "db",
      "upload",
      "--mode",
      "unknown",
    ])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("data-copy")
    expect(result.output).toContain("exact-restore")
  })

  it("fails local-file validation before any backend call", async () => {
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runUploadDb("0000-0000-0001", "dev", "/missing/upload.sqlite", {
        createExecutionEventSource: createExecutionEventSource(
          completedExecution("exec-upload-1"),
        ),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(fetchCalled).toBe(false)
  })

  it("rejects files that do not look like SQLite databases before mutation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-invalid-"))
    tempPaths.push(testDir)
    const inputPath = join(testDir, "not-sqlite.txt")
    writeFileSync(inputPath, "not sqlite")
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runUploadDb("0000-0000-0001", "dev", inputPath, {
        createExecutionEventSource: createExecutionEventSource(
          completedExecution("exec-upload-1"),
        ),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(fetchCalled).toBe(false)
  })

  it("rejects empty files before mutation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-empty-"))
    tempPaths.push(testDir)
    const inputPath = join(testDir, "empty.sqlite")
    writeFileSync(inputPath, "")
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runUploadDb("0000-0000-0001", "dev", inputPath, {
        createExecutionEventSource: createExecutionEventSource(
          completedExecution("exec-upload-1"),
        ),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(fetchCalled).toBe(false)
  })

  it("rejects directory inputs before mutation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-directory-"))
    tempPaths.push(testDir)
    const inputPath = join(testDir, "directory.sqlite")
    mkdirSync(inputPath)
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return graphqlResponse({})
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runUploadDb("0000-0000-0001", "dev", inputPath, {
        createExecutionEventSource: createExecutionEventSource(
          completedExecution("exec-upload-1"),
        ),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(fetchCalled).toBe(false)
  })

  it("uploads bytes through the signed URL and waits for backend apply", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-success-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const inputPath = join(testDir, "upload.sqlite")
    writeFileSync(inputPath, SQLITE_BYTES)
    let signedUploadCalled = false
    let startApplyCalled = false

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === "https://secret-upload.example.test/db.sqlite?token=secret") {
        signedUploadCalled = true
        expect(init?.method).toBe("PUT")
        expect(init?.headers).toEqual({
          "Content-Length": String(SQLITE_BYTES.length),
          "Content-Type": "application/vnd.sqlite3",
        })
        const body = init?.body
        if (!body) {
          throw new Error("Signed upload was missing a request body")
        }
        const uploadedBytes = Buffer.from(
          await new Response(body).arrayBuffer(),
        )
        expect(uploadedBytes.equals(SQLITE_BYTES)).toBe(true)
        return new Response("", { status: 200 })
      }

      const body = readGraphqlBody(init)

      if (body.query.includes("listProjectEnvironments")) {
        return graphqlResponse({
          listProjectEnvironments: { items: [{ environmentName: "dev" }] },
        })
      }

      if (body.query.includes("requestDatabaseUploadUrl")) {
        expect(body.variables).toEqual({
          project: "0000-0000-0001",
          env: "dev",
          contentType: "application/vnd.sqlite3",
          filename: "upload.sqlite",
        })
        return graphqlResponse({
          requestDatabaseUploadUrl: {
            operationId: "operation-upload-1",
            fileId: "file-upload-1",
            documentStore: "/database-transfer",
            uploadUrl:
              "https://secret-upload.example.test/db.sqlite?token=secret",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "READY_FOR_UPLOAD",
            target: { project: "0000-0000-0001", env: "dev" },
          },
        })
      }

      if (body.query.includes("subscriptionTransport")) {
        return graphqlResponse({
          subscriptionTransport: {
            kind: "GRAPHQL_WS",
            appSyncEventsHttpHost: null,
          },
        })
      }

      if (body.query.includes("startOperationsUploadDb")) {
        startApplyCalled = true
        expect(body.variables).toEqual({
          projectId: "0000-0000-0001",
          environmentId: "dev",
          fileId: "file-upload-1",
          mode: "data-copy",
        })
        return graphqlResponse({
          startOperationsUploadDb: {
            executionId: "exec-upload-1",
            processPath: "operations/upload-db",
          },
        })
      }

      return unexpectedGraphqlOperation(body.query)
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const { output, result } = await captureStdout(async () =>
      Effect.runPromise(
        runUploadDb("0000-0000-0001", "dev", inputPath, {
          createExecutionEventSource: createExecutionEventSource(
            completedExecution("exec-upload-1"),
          ),
          fetch: fetchImpl,
        }),
      ),
    )

    expect(result).toEqual({
      operationId: "operation-upload-1",
      executionId: "exec-upload-1",
      fileId: "file-upload-1",
      mode: "data-copy",
      status: "APPLIED",
    })
    expect(signedUploadCalled).toBe(true)
    expect(startApplyCalled).toBe(true)
    expect(output).toContain("Database upload transfer ready")
    expect(output).toContain("Database upload applied")
    expect(output).toContain("operation-upload-1")
    expect(output).toContain("exec-upload-1")
    expect(output).toContain("file-upload-1")
    expect(output).toContain(inputPath)
    expect(output).toContain("APPLIED")
    expect(output).not.toContain("secret-upload")
    expect(output).not.toContain("token=secret")
  })

  it("cleans up and does not start apply when the signed upload fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const inputPath = join(testDir, "upload.sqlite")
    writeFileSync(inputPath, SQLITE_BYTES)
    let deleteCalled = false
    let startApplyCalled = false

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (
        String(input) === "https://secret-upload.example.test/fail?token=secret"
      ) {
        return new Response(
          "https://secret-upload.example.test/fail?token=secret",
          {
            status: 403,
          },
        )
      }

      const body = readGraphqlBody(init)

      if (body.query.includes("listProjectEnvironments")) {
        return graphqlResponse({
          listProjectEnvironments: { items: [{ environmentName: "dev" }] },
        })
      }

      if (body.query.includes("requestDatabaseUploadUrl")) {
        return graphqlResponse({
          requestDatabaseUploadUrl: {
            operationId: "operation-upload-1",
            fileId: "file-upload-1",
            documentStore: "/database-transfer",
            uploadUrl: "https://secret-upload.example.test/fail?token=secret",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "READY_FOR_UPLOAD",
            target: { project: "0000-0000-0001", env: "dev" },
          },
        })
      }

      if (body.query.includes("deleteFile")) {
        deleteCalled = true
        expect(body.variables).toEqual({ fileId: "file-upload-1" })
        return graphqlResponse({ deleteFile: { success: true } })
      }

      if (body.query.includes("startOperationsUploadDb")) {
        startApplyCalled = true
      }

      return unexpectedGraphqlOperation(body.query)
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const { output, result } = await captureStdout(async () =>
      Effect.runPromiseExit(
        runUploadDb("0000-0000-0001", "dev", inputPath, {
          createExecutionEventSource: createExecutionEventSource(
            completedExecution("exec-upload-1"),
          ),
          fetch: fetchImpl,
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(deleteCalled).toBe(true)
    expect(startApplyCalled).toBe(false)
    expect(output).not.toContain("secret-upload")
    expect(output).not.toContain("token=secret")
  })

  it("cleans up when the backend apply flow cannot be started", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-start-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const inputPath = join(testDir, "upload.sqlite")
    writeFileSync(inputPath, SQLITE_BYTES)
    let deleteCalled = false
    let startApplyCalled = false

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input) === "https://secret-upload.example.test/db.sqlite") {
        return new Response("", { status: 200 })
      }

      const body = readGraphqlBody(init)

      if (body.query.includes("listProjectEnvironments")) {
        return graphqlResponse({
          listProjectEnvironments: { items: [{ environmentName: "dev" }] },
        })
      }

      if (body.query.includes("requestDatabaseUploadUrl")) {
        return graphqlResponse({
          requestDatabaseUploadUrl: {
            operationId: "operation-upload-1",
            fileId: "file-upload-1",
            documentStore: "/database-transfer",
            uploadUrl: "https://secret-upload.example.test/db.sqlite",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "READY_FOR_UPLOAD",
            target: { project: "0000-0000-0001", env: "dev" },
          },
        })
      }

      if (body.query.includes("subscriptionTransport")) {
        return graphqlResponse({
          subscriptionTransport: {
            kind: "GRAPHQL_WS",
            appSyncEventsHttpHost: null,
          },
        })
      }

      if (body.query.includes("startOperationsUploadDb")) {
        startApplyCalled = true
        return new Response(
          JSON.stringify({ errors: [{ message: "Cannot query field" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      if (body.query.includes("deleteFile")) {
        deleteCalled = true
        expect(body.variables).toEqual({ fileId: "file-upload-1" })
        return graphqlResponse({ deleteFile: { success: true } })
      }

      return unexpectedGraphqlOperation(body.query)
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const { output, result } = await captureStdout(async () =>
      Effect.runPromiseExit(
        runUploadDb("0000-0000-0001", "dev", inputPath, {
          createExecutionEventSource: createExecutionEventSource(
            completedExecution("exec-upload-1"),
          ),
          fetch: fetchImpl,
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(deleteCalled).toBe(true)
    expect(startApplyCalled).toBe(true)
    expect(output).not.toContain("secret-upload")
  })

  it("cleans up when subscription setup fails after upload", async () => {
    const testDir = mkdtempSync(
      join(tmpdir(), "pfcli-db-upload-subscription-fail-"),
    )
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const inputPath = join(testDir, "upload.sqlite")
    writeFileSync(inputPath, SQLITE_BYTES)
    let deleteCalled = false
    let startApplyCalled = false

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input) === "https://secret-upload.example.test/db.sqlite") {
        return new Response("", { status: 200 })
      }

      const body = readGraphqlBody(init)

      if (body.query.includes("listProjectEnvironments")) {
        return graphqlResponse({
          listProjectEnvironments: { items: [{ environmentName: "dev" }] },
        })
      }

      if (body.query.includes("requestDatabaseUploadUrl")) {
        return graphqlResponse({
          requestDatabaseUploadUrl: {
            operationId: "operation-upload-1",
            fileId: "file-upload-1",
            documentStore: "/database-transfer",
            uploadUrl: "https://secret-upload.example.test/db.sqlite",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "READY_FOR_UPLOAD",
            target: { project: "0000-0000-0001", env: "dev" },
          },
        })
      }

      if (body.query.includes("subscriptionTransport")) {
        return new Response(
          JSON.stringify({ errors: [{ message: "subscription unavailable" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      if (body.query.includes("deleteFile")) {
        deleteCalled = true
        expect(body.variables).toEqual({ fileId: "file-upload-1" })
        return graphqlResponse({ deleteFile: { success: true } })
      }

      if (body.query.includes("startOperationsUploadDb")) {
        startApplyCalled = true
      }

      return unexpectedGraphqlOperation(body.query)
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const { output, result } = await captureStdout(async () =>
      Effect.runPromiseExit(
        runUploadDb("0000-0000-0001", "dev", inputPath, {
          createExecutionEventSource: createExecutionEventSource(
            completedExecution("exec-upload-1"),
          ),
          fetch: fetchImpl,
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(deleteCalled).toBe(true)
    expect(startApplyCalled).toBe(false)
    expect(output).not.toContain("secret-upload")
  })

  it("fails when the backend apply execution fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-upload-apply-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const inputPath = join(testDir, "upload.sqlite")
    writeFileSync(inputPath, SQLITE_BYTES)
    let startApplyCalled = false

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input) === "https://upload.example.test/db.sqlite") {
        return new Response("", { status: 200 })
      }

      const body = readGraphqlBody(init)

      if (body.query.includes("listProjectEnvironments")) {
        return graphqlResponse({
          listProjectEnvironments: { items: [{ environmentName: "dev" }] },
        })
      }

      if (body.query.includes("requestDatabaseUploadUrl")) {
        return graphqlResponse({
          requestDatabaseUploadUrl: {
            operationId: "operation-upload-1",
            fileId: "file-upload-1",
            documentStore: "/database-transfer",
            uploadUrl: "https://upload.example.test/db.sqlite",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "READY_FOR_UPLOAD",
            target: { project: "0000-0000-0001", env: "dev" },
          },
        })
      }

      if (body.query.includes("subscriptionTransport")) {
        return graphqlResponse({
          subscriptionTransport: {
            kind: "GRAPHQL_WS",
            appSyncEventsHttpHost: null,
          },
        })
      }

      if (body.query.includes("startOperationsUploadDb")) {
        startApplyCalled = true
        expect(body.variables["mode"]).toBe("exact-restore")
        return graphqlResponse({
          startOperationsUploadDb: {
            executionId: "exec-upload-1",
            processPath: "operations/upload-db",
          },
        })
      }

      return unexpectedGraphqlOperation(body.query)
    }) as unknown as typeof fetch
    globalThis.fetch = fetchImpl

    const { output, result } = await captureStdout(async () =>
      Effect.runPromiseExit(
        runUploadDb("0000-0000-0001", "dev", inputPath, {
          createExecutionEventSource: createExecutionEventSource({
            ...failedExecution("exec-upload-1"),
            failureReason:
              "Database upload apply failed; recovery snapshot snapshot-file-1 is preserved",
          }),
          fetch: fetchImpl,
          mode: "exact-restore",
        }),
      ),
    )

    expect(startApplyCalled).toBe(true)
    expect(Exit.isFailure(result)).toBe(true)
    expect(getFailureMessage(result)).toBe(
      "Database upload apply failed; recovery snapshot snapshot-file-1 is preserved",
    )
    expect(output).toContain("operation-upload-1")
    expect(output).toContain("file-upload-1")
    expect(output).not.toContain("https://upload.example.test/db.sqlite")
  })
})
