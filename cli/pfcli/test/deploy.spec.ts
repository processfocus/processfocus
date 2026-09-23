import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import {
  ORGANISATION_DEPLOY_MANIFEST_FILE,
  ORGANISATION_DEPLOY_MANIFEST_VERSION,
} from "@pf/process"
import type {
  DeployProgressEventSource,
  DeployProgressEventSourceConfig,
} from "../src/utils/deploy-progress-subscription.types"
import { runPfcliInProcess, useSerializedTestState } from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

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
  readonly realtimeUrl: string
  readonly appSyncEventsHttpHost: string
  readonly accessToken: string
  readonly userId: string
}

type RunDeploy = (
  orgPath: string,
  projectId: string,
  environmentId: string,
  options?: { waitForCompletion?: boolean },
  dependencies?: {
    createExecutionEventSource?: (
      config: ExecutionEventSourceConfig,
    ) => Effect.Effect<ExecutionEventSource>
    createDeployProgressEventSource?: (
      config: DeployProgressEventSourceConfig,
    ) => Effect.Effect<DeployProgressEventSource>
    buildOrg?: (orgPath: string) => Effect.Effect<unknown>
    prepareArtifact?:
      | ((orgPath: string, artifactPath: string) => Effect.Effect<void>)
      | undefined
  },
) => Effect.Effect<unknown>

const loadRunDeploy = async (): Promise<RunDeploy> => {
  const modulePath = join(WORKSPACE_ROOT, "cli/pfcli/src/commands/deploy.ts")
  const module = (await import(modulePath)) as {
    runDeploy: RunDeploy
  }
  return module.runDeploy
}

const executionSnapshot = (
  status = "Completed",
  failureReason: string | null = null,
): ExecutionSnapshot => ({
  id: "exec-1",
  status,
  failureReason,
  abandonedReason: null,
  finishedAt: null,
  steps: [],
})
const executionSource = (
  snapshot = executionSnapshot(),
): ExecutionEventSource => ({
  close: async () => undefined,
  async *[Symbol.asyncIterator]() {
    yield snapshot
  },
})
const silentSource = <T>(): AsyncIterable<T> & {
  close: () => Promise<void>
} => ({
  close: async () => undefined,
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<T>>(() => {}),
  }),
})

const runDeployEffect = async (
  orgPath: string,
  projectId: string,
  environmentId: string,
  options?: { waitForCompletion?: boolean },
  dependencies?: Parameters<RunDeploy>[4],
) =>
  (await loadRunDeploy())(orgPath, projectId, environmentId, options, {
    createExecutionEventSource: () => Effect.succeed(executionSource()),
    buildOrg: () => Effect.void,
    prepareArtifact: (_orgPath, artifactPath) =>
      Effect.sync(() => writeFileSync(artifactPath, "prepared archive")),
    ...dependencies,
  })

const createTempOrg = (options: { includeCustomMigrations?: boolean } = {}) => {
  const orgPath = mkdtempSync(join(tmpdir(), "pfcli-deploy-org-"))
  const distPath = join(orgPath, "dist")
  const orgBundle = "console.log('bundle')"
  mkdirSync(distPath, { recursive: true })
  writeFileSync(join(distPath, "org.js"), orgBundle)
  writeFileSync(
    join(distPath, ORGANISATION_DEPLOY_MANIFEST_FILE),
    `${JSON.stringify(
      {
        version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
        orgBundleSha256: createHash("sha256").update(orgBundle).digest("hex"),
        awsFunctionNames: [],
        hasLongDurationSteps: false,
        dockerSteps: [],
        documentStores: [],
      },
      null,
      2,
    )}\n`,
  )

  if (options.includeCustomMigrations) {
    mkdirSync(join(orgPath, "drizzle"), { recursive: true })
    writeFileSync(join(orgPath, "drizzle.config.ts"), "export default {}\n")
    writeFileSync(join(orgPath, "drizzle", "0001_test.sql"), "-- test\n")
  }

  return orgPath
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

const createFakeZip = (
  baseDir: string,
  options: { requireCustomMigrations?: boolean } = {},
) => {
  const binDir = join(baseDir, "bin")
  mkdirSync(binDir, { recursive: true })
  const zipPath = join(binDir, "zip")
  writeFileSync(
    zipPath,
    `#!/usr/bin/env bash
set -euo pipefail
out="$3"
[ -d dist ]
[ -f "dist/${ORGANISATION_DEPLOY_MANIFEST_FILE}" ]
[ -f .pf-deploy.json ]
${options.requireCustomMigrations ? "[ -f drizzle.config.ts ]\n[ -d drizzle ]\n[ -f drizzle/0001_test.sql ]" : ""}
echo "fake-zip" > "$out"
`,
    { mode: 0o755 },
  )
  return binDir
}

const runCliDeploy = (
  orgPath: string,
  credentialsPath: string,
  extraEnv: Record<string, string> = {},
  includeDeployOptions = true,
) =>
  spawnSync(
    "bun",
    includeDeployOptions
      ? [
          PFCLI,
          "deploy",
          orgPath,
          "--project",
          "project-123",
          "--env",
          "env-456",
          "--no-wait",
        ]
      : [PFCLI, "deploy", orgPath],
    {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PFCLI_CREDENTIALS_PATH: credentialsPath,
        ...extraEnv,
      },
    },
  )

interface DeployFetchMockOptions {
  subscriptionTransportKind?: "GRAPHQL_WS" | "APPSYNC_EVENTS"
  appSyncEventsHttpHost?: string | null
  onStartOperationsDeploy?: () => void
  failDnsRecordsRequest?: boolean
  dnsRecords?: {
    customDomain?: string | null
    frontendUrl?: string
    frontendUrlNote?: string | null
  }
}

const createDeployFetchMock = (options: DeployFetchMockOptions = {}) =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return new Response("", { status: 200 })
    }

    const body = JSON.parse(String(init?.body)) as { query: string }

    if (body.query.includes("requestUploadUrl")) {
      return new Response(
        JSON.stringify({
          data: {
            requestUploadUrl: {
              fileId: "file-1",
              uploadUrl: "http://upload.test/put",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    if (body.query.includes("subscriptionTransport")) {
      return new Response(
        JSON.stringify({
          data: {
            subscriptionTransport: {
              kind: options.subscriptionTransportKind ?? "GRAPHQL_WS",
              appSyncEventsHttpHost: options.appSyncEventsHttpHost ?? null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    if (body.query.includes("startOperationsDeploy")) {
      options.onStartOperationsDeploy?.()
      return new Response(
        JSON.stringify({
          data: {
            startOperationsDeploy: {
              executionId: "exec-1",
              processPath: "operations/deploy",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    if (body.query.includes("DeployExecutionLocation")) {
      return Response.json({
        data: {
          executions: {
            nodes: [{ id: "exec-1", startedAt: "2026-09-22T00:00:00Z" }],
            hasNextPage: false,
          },
        },
      })
    }

    if (body.query.includes("DeployExecutionSnapshot")) {
      return Response.json({
        data: {
          pullExecution: {
            documents: [executionSnapshot("Running")],
            checkpoint: null,
          },
        },
      })
    }

    if (body.query.includes("getDnsRecords")) {
      if (options.failDnsRecordsRequest) {
        return new Response("boom", { status: 500 })
      }

      return new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              customDomain: options.dnsRecords?.customDomain ?? null,
              frontendUrl:
                options.dnsRecords?.frontendUrl ??
                "https://env-456.project-123.app.processfocus.com",
              frontendUrlNote: options.dnsRecords?.frontendUrlNote ?? null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    return new Response("not-found", { status: 404 })
  }) as unknown as typeof fetch

const captureConsoleLogs = async (
  run: () => Promise<void>,
): Promise<string[]> => {
  const logs: string[] = []
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }

  try {
    await run()
    return logs
  } finally {
    console.log = originalConsoleLog
  }
}

describe("pfcli deploy", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalPath = process.env["PATH"]
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalRuntimeRoot = process.env["PF_RUNTIME_ROOT"]

  afterEach(() => {
    for (const p of tempPaths) {
      rmSync(p, { recursive: true, force: true })
    }
    tempPaths.length = 0
    globalThis.fetch = originalFetch
    process.env["PATH"] = originalPath
    if (originalCredPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
    }
    if (originalRuntimeRoot === undefined) {
      delete process.env["PF_RUNTIME_ROOT"]
    } else {
      process.env["PF_RUNTIME_ROOT"] = originalRuntimeRoot
    }
  })

  const isCliError = (
    value: unknown,
  ): value is { _tag: string; message: string } =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    "message" in value

  it("fails when credentials are missing", () => {
    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const missingCredentials = join(orgPath, "missing-credentials.json")
    const result = runCliDeploy(orgPath, missingCredentials)

    expect(result.status).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toContain('Run "pfcli auth login"')
  })

  it("shows a clear error when required deploy options are missing", async () => {
    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const result = await runPfcliInProcess(["deploy", orgPath])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing required deploy option(s)")
    expect(output).toContain("--project")
    expect(output).toContain("--env")
  })

  it("shows a clean error when deploy org-path argument is missing", async () => {
    const result = await runPfcliInProcess(["deploy"])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing argument <org-path>")
    expect(output).not.toContain('"_tag":"MissingValue"')
    expect(output).not.toContain("ERROR (#")
  })

  it("fails when credentials are expired", () => {
    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      orgPath,
      "http://example.test",
      new Date(Date.now() - 60_000).toISOString(),
    )
    const result = runCliDeploy(orgPath, credentialsPath)

    expect(result.status).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toContain('Run "pfcli auth login"')
  })

  it("shows clear message when token audience is not graphql-api", () => {
    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      orgPath,
      "http://example.test",
      new Date(Date.now() + 60_000).toISOString(),
      createJwt({ aud: "frontend" }),
    )

    const result = runCliDeploy(orgPath, credentialsPath)

    expect(result.status).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toContain("CLI token audience is frontend")
    expect(output).toContain("expected graphql-api")
  })

  it("uses GraphQL port file when credentials base URL is localhost", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://localhost:3000",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    const graphqlPort = 5100
    writeFileSync(
      join(testDir, ".graphql-port.json"),
      JSON.stringify({ port: graphqlPort }),
    )

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`
    process.env["PF_RUNTIME_ROOT"] = testDir

    let usedFrontendEndpoint = false
    let usedGraphqlEndpoint = false

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PUT") {
        return new Response("", { status: 200 })
      }

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url === "http://localhost:3000/graphql") {
        usedFrontendEndpoint = true
        return new Response("<!DOCTYPE html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url === `http://localhost:${String(graphqlPort)}/graphql`) {
        usedGraphqlEndpoint = true

        const body = JSON.parse(String(init?.body)) as { query: string }

        if (body.query.includes("requestUploadUrl")) {
          return new Response(
            JSON.stringify({
              data: {
                requestUploadUrl: {
                  fileId: "file-1",
                  uploadUrl: "http://upload.test/put",
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }

        if (body.query.includes("startOperationsDeploy")) {
          return new Response(
            JSON.stringify({
              data: {
                startOperationsDeploy: {
                  executionId: "exec-1",
                  processPath: "operations/deploy",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
      }

      return new Response("not-found", { status: 404 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      await runDeployEffect(orgPath, "project-123", "env-456", {
        waitForCompletion: false,
      }),
    )

    expect(usedFrontendEndpoint).toBe(false)
    expect(usedGraphqlEndpoint).toBe(true)
  })

  it("fails with auth guidance when requestUploadUrl returns 401", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch

    const error: unknown = await Effect.runPromise(
      (
        await runDeployEffect(orgPath, "project-123", "env-456", {
          waitForCompletion: false,
        })
      ).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error._tag).toBe("CliError")
      expect(error.message).toContain('Run "pfcli auth login"')
    }
  })

  it("fails with auth guidance when start deploy returns 401", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    let graphqlCallCount = 0
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PUT") {
        return new Response("", { status: 200 })
      }
      graphqlCallCount += 1
      if (graphqlCallCount === 1) {
        return new Response(
          JSON.stringify({
            data: {
              requestUploadUrl: {
                fileId: "file-1",
                uploadUrl: "http://upload.test/put",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("unauthorized", { status: 401 })
    }) as unknown as typeof fetch

    const error: unknown = await Effect.runPromise(
      (
        await runDeployEffect(orgPath, "project-123", "env-456", {
          waitForCompletion: false,
        })
      ).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error._tag).toBe("CliError")
      expect(error.message).toContain('Run "pfcli auth login"')
    }
  })

  it("uploads artifact and starts deployment on happy path", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath

    let startCalled = false
    let uploadCalled = false

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "PUT") {
        uploadCalled = true
        if (!(init.body instanceof Uint8Array)) {
          throw new Error("Expected deployment upload body to be bytes")
        }
        expect(Buffer.from(init.body).subarray(0, 2).toString()).toBe("PK")
        return new Response("", { status: 200 })
      }

      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: { documentStore?: string; stepPath?: string }
      }

      if (body.query.includes("requestUploadUrl")) {
        expect(body.variables?.stepPath).toBe(
          "/operations/deploy/Upload artifact",
        )
        expect(body.variables?.documentStore).toBe("/org-upload")
        return new Response(
          JSON.stringify({
            data: {
              requestUploadUrl: {
                fileId: "file-1",
                uploadUrl: "http://upload.test/put",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      if (body.query.includes("startOperationsDeploy")) {
        startCalled = true
        return new Response(
          JSON.stringify({
            data: {
              startOperationsDeploy: {
                executionId: "exec-1",
                processPath: "operations/deploy",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response("not-found", { status: 404 })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: false },
        { prepareArtifact: undefined },
      ),
    )

    expect(uploadCalled).toBe(true)
    expect(startCalled).toBe(true)
  })

  it("includes custom migration files in the deployment artifact when present", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg({ includeCustomMigrations: true })
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir, { requireCustomMigrations: true })

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`
    globalThis.fetch = createDeployFetchMock()

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        {
          waitForCompletion: false,
        },
        { prepareArtifact: undefined },
      ),
    )
  })

  it("surfaces deployment archive command failures", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)
    const orgPath = createTempOrg()
    tempPaths.push(orgPath)
    const artifactPath = join(testDir, "missing", "failed.zip")
    const module = await import("../src/commands/deploy")

    const error: unknown = await Effect.runPromise(
      module.prepareDeploymentArtifact(orgPath, artifactPath).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toBe("zip command failed with exit code 15")
    }
  })

  it("subscribes before starting deployment and waits for completion when requested", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

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
            name: "Execute deployment",
            path: "/deploy",
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
            name: "Execute deployment",
            path: "/deploy",
            status: "Completed",
            failureReason: null,
          },
        ],
      },
    ]

    globalThis.fetch = createDeployFetchMock({
      onStartOperationsDeploy: () => {
        startCalled = true
        expect(eventSourceCreated).toBe(true)
      },
    })

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
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: true },
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

  it("prints the live frontend URL after a successful deployment", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      dnsRecords: {
        customDomain: "dashboard.example.com",
        frontendUrl: "https://dashboard.example.com",
      },
    })

    const fakeEventSource: ExecutionEventSource = {
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
    }

    const logs = await captureConsoleLogs(async () => {
      await Effect.runPromise(
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createExecutionEventSource: () => Effect.succeed(fakeEventSource),
          },
        ),
      )
    })

    expect(logs).toContain("Frontend URL: https://dashboard.example.com")
    expect(logs.some((log) => log.includes("Configured custom domain:"))).toBe(
      false,
    )
    expect(logs.some((log) => log.includes("Note:"))).toBe(false)
  })

  it("prints the fallback frontend URL and custom-domain note after deployment", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      dnsRecords: {
        customDomain: "dashboard.example.com",
        frontendUrl: "https://env-456.project-123.app.processfocus.com",
        frontendUrlNote:
          "custom domain is not live yet; keep using the default app domain until validation completes and you redeploy.",
      },
    })

    const fakeEventSource: ExecutionEventSource = {
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
    }

    const logs = await captureConsoleLogs(async () => {
      await Effect.runPromise(
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createExecutionEventSource: () => Effect.succeed(fakeEventSource),
          },
        ),
      )
    })

    expect(logs).toContain(
      "Frontend URL: https://env-456.project-123.app.processfocus.com",
    )
    expect(logs).toContain(
      "Configured custom domain: https://dashboard.example.com",
    )
    expect(logs).toContain(
      "Note: custom domain is not live yet; keep using the default app domain until validation completes and you redeploy.",
    )
  })

  it("keeps deploy completion successful when dns records lookup fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      failDnsRecordsRequest: true,
    })

    const fakeEventSource: ExecutionEventSource = {
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
    }

    const logs = await captureConsoleLogs(async () => {
      await Effect.runPromise(
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createExecutionEventSource: () => Effect.succeed(fakeEventSource),
          },
        ),
      )
    })

    expect(logs.some((log) => log.endsWith("Deployment completed."))).toBe(true)
    expect(logs.some((log) => log.includes("Frontend URL:"))).toBe(false)
  })

  for (const timing of [
    "before subscription",
    "during snapshot",
    "after snapshot",
  ] as const) {
    it.each([
      null,
      "Command exited with code 1 | build status FAILED | current phase COMPLETED",
      "Insufficient project credit for project 1000-0000-0001. Remaining balance: USD -0.001. An operator must add credit before deploying.",
      "Unable to check project credit for project 1000-0000-0001. Please retry the deployment.",
    ])(
      `reports persisted outcomes ${timing} with silent progress: %s`,
      async (failure) => {
        const testDir = mkdtempSync(join(tmpdir(), "pfcli-outcome-"))
        const orgPath = createTempOrg()
        tempPaths.push(testDir, orgPath)
        process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
          testDir,
          "https://deploy.example.test",
          new Date(Date.now() + 60_000).toISOString(),
          createJwt({ aud: "graphql-api", properties: { userId: "user-123" } }),
        )
        const terminal = executionSnapshot(
          failure ? "Failed" : "Completed",
          failure,
        )
        const ready = Promise.withResolvers<void>()
        const snapshotStarted = Promise.withResolvers<void>()
        const snapshotRead = Promise.withResolvers<void>()
        const events: ExecutionSnapshot[] = []
        let pending:
          | ((value: IteratorResult<ExecutionSnapshot>) => void)
          | undefined
        let executionClosed = 0
        let progressClosed = 0
        const push = (value: ExecutionSnapshot) => {
          if (pending) {
            const resolve = pending
            pending = undefined
            resolve({ done: false, value })
          } else events.push(value)
        }
        const source: ExecutionEventSource = {
          close: async () => {
            executionClosed++
            pending?.({ done: true, value: undefined })
          },
          [Symbol.asyncIterator]: () => ({
            next: () => {
              const value = events.shift()
              return value
                ? Promise.resolve({ done: false, value })
                : new Promise((resolve) => {
                    pending = resolve
                  })
            },
          }),
        }
        const baseFetch = createDeployFetchMock({
          subscriptionTransportKind: "APPSYNC_EVENTS",
          appSyncEventsHttpHost: "appsync.test",
        })
        let subscribed = false
        let queried = false
        globalThis.fetch = Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            if (String(init?.body).includes("DeployExecutionSnapshot")) {
              expect(subscribed).toBe(true)
              queried = true
              snapshotStarted.resolve()
              if (timing === "during snapshot") {
                push({ ...terminal, id: "other-execution" })
                push(terminal)
                push(terminal)
                await snapshotRead.promise
              }
              const response = Response.json({
                data: {
                  pullExecution: {
                    documents: [
                      timing === "before subscription"
                        ? terminal
                        : executionSnapshot("Running"),
                    ],
                    checkpoint: null,
                  },
                },
              })
              snapshotRead.resolve()
              return response
            }
            return baseFetch(input, init)
          },
          { preconnect: baseFetch.preconnect },
        )
        const effect = await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          {},
          {
            createExecutionEventSource: () =>
              Effect.promise(async () => {
                await ready.promise
                subscribed = true
                return source
              }),
            createDeployProgressEventSource: () =>
              Effect.succeed({
                ...silentSource(),
                close: async () => {
                  progressClosed++
                },
              }),
          },
        )
        const logs = await captureConsoleLogs(async () => {
          const result = Effect.runPromise(Effect.either(effect))
          expect(queried).toBe(false)
          ready.resolve()
          await snapshotStarted.promise
          if (timing === "during snapshot") {
            // The terminal event must finish the command without awaiting this stale response.
            const outcome = await result
            expect(outcome._tag).toBe(failure ? "Left" : "Right")
            snapshotRead.resolve()
          } else if (timing === "after snapshot") {
            await snapshotRead.promise
            push({ ...terminal, id: "other-execution" })
            push(terminal)
            push(terminal)
          }
          const outcome = await result
          if (failure) {
            expect(outcome._tag).toBe("Left")
            if (outcome._tag === "Left")
              expect(String(outcome.left)).toContain(failure)
          } else expect(outcome._tag).toBe("Right")
        })
        expect(executionClosed).toBe(1)
        expect(progressClosed).toBe(1)
        expect(
          logs.filter((line) => line.includes("Deployment completed.")).length,
        ).toBe(failure ? 0 : 1)
        if (!failure) expect(logs.join("\n")).toContain("Frontend URL:")
      },
    )
  }

  it.each(["snapshot error", "cancel"])(
    "cleans up a silent AppSync deployment on %s",
    async (mode) => {
      const testDir = mkdtempSync(join(tmpdir(), "pfcli-cleanup-"))
      const orgPath = createTempOrg()
      tempPaths.push(testDir, orgPath)
      process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
        testDir,
        "https://deploy.example.test",
        new Date(Date.now() + 60_000).toISOString(),
        createJwt({ properties: { userId: "user-123" } }),
      )
      const fetched = Promise.withResolvers<void>()
      const baseFetch = createDeployFetchMock({
        subscriptionTransportKind: "APPSYNC_EVENTS",
        appSyncEventsHttpHost: "appsync.test",
      })
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(init?.body).includes("DeployExecutionSnapshot")) {
            fetched.resolve()
            return mode === "snapshot error"
              ? Response.json({
                  errors: [{ message: "Execution access denied" }],
                })
              : Response.json({
                  data: {
                    pullExecution: {
                      documents: [executionSnapshot("Running")],
                      checkpoint: null,
                    },
                  },
                })
          }
          return baseFetch(input, init)
        },
        { preconnect: baseFetch.preconnect },
      )
      let executionClosed = 0
      let progressClosed = 0
      const controller = new AbortController()
      const effect = await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        {},
        {
          createExecutionEventSource: () =>
            Effect.succeed({
              ...silentSource<ExecutionSnapshot>(),
              close: async () => {
                executionClosed++
              },
            }),
          createDeployProgressEventSource: () =>
            Effect.succeed({
              ...silentSource(),
              close: async () => {
                progressClosed++
              },
            }),
        },
      )
      const result = Effect.runPromise(effect, { signal: controller.signal })
      await fetched.promise
      if (mode === "cancel") controller.abort()
      await expect(result).rejects.toThrow(
        mode === "cancel"
          ? ""
          : "Failed to read deployment execution status: GraphQL error: Execution access denied",
      )
      expect(executionClosed).toBe(1)
      expect(progressClosed).toBe(1)
    },
  )

  it("waits for dedicated AppSync deploy progress events when available", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    let startCalled = false
    let progressSourceCreated = false
    let progressSourceClosed = false

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
      onStartOperationsDeploy: () => {
        startCalled = true
      },
    })

    const fakeProgressSource: DeployProgressEventSource = {
      close: async () => {
        progressSourceClosed = true
      },
      async *[Symbol.asyncIterator]() {
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "store",
          status: "progress",
          message: "Deploying database and document store",
          timestamp: new Date().toISOString(),
        }
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "deployment",
          status: "completed",
          message: "Deployment completed.",
          timestamp: new Date().toISOString(),
        }
      },
    }

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: true },
        {
          createDeployProgressEventSource: () =>
            Effect.sync(() => {
              progressSourceCreated = true
              expect(startCalled).toBe(true)
              return fakeProgressSource
            }),
          createExecutionEventSource: () => Effect.succeed(executionSource()),
        },
      ),
    )

    expect(progressSourceCreated).toBe(true)
    expect(progressSourceClosed).toBe(true)
  })

  it("falls back to execution updates when AppSync deploy progress disconnects", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    let progressSourceClosed = false
    let executionSourceCreated = false
    let executionSourceClosed = false

    const fakeProgressSource: DeployProgressEventSource = {
      close: async () => {
        progressSourceClosed = true
      },
      async *[Symbol.asyncIterator]() {
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "frontend",
          status: "progress",
          message: "Deploying frontend",
          timestamp: new Date().toISOString(),
        }
        throw new Error("Lost the deploy progress connection (close code 1000)")
      },
    }

    const fakeEventSource: ExecutionEventSource = {
      close: async () => {
        executionSourceClosed = true
      },
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
    }

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: true },
        {
          createDeployProgressEventSource: () =>
            Effect.succeed(fakeProgressSource),
          createExecutionEventSource: () =>
            Effect.sync(() => {
              executionSourceCreated = true
              return fakeEventSource
            }),
        },
      ),
    )

    expect(progressSourceClosed).toBe(true)
    expect(executionSourceCreated).toBe(true)
    expect(executionSourceClosed).toBe(true)
  })

  it("falls back to execution updates when AppSync deploy progress ends early", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    let progressSourceClosed = false
    let executionSourceCreated = false
    let executionSourceClosed = false

    const fakeProgressSource: DeployProgressEventSource = {
      close: async () => {
        progressSourceClosed = true
      },
      async *[Symbol.asyncIterator]() {
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "frontend",
          status: "progress",
          message: "Deploying frontend",
          timestamp: new Date().toISOString(),
        }
      },
    }

    const fakeEventSource: ExecutionEventSource = {
      close: async () => {
        executionSourceClosed = true
      },
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
    }

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: true },
        {
          createDeployProgressEventSource: () =>
            Effect.succeed(fakeProgressSource),
          createExecutionEventSource: () =>
            Effect.sync(() => {
              executionSourceCreated = true
              return fakeEventSource
            }),
        },
      ),
    )

    expect(progressSourceClosed).toBe(true)
    expect(executionSourceCreated).toBe(true)
    expect(executionSourceClosed).toBe(true)
  })

  it("does not fall back when AppSync deploy progress fails for another reason", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    const fakeProgressSource: DeployProgressEventSource = {
      close: async () => undefined,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("AppSync authorization failed")
          },
        }
      },
    }

    const error: unknown = await Effect.runPromise(
      (
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createDeployProgressEventSource: () =>
              Effect.succeed(fakeProgressSource),
            createExecutionEventSource: () =>
              Effect.succeed(silentSource<ExecutionSnapshot>()),
          },
        )
      ).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toContain("AppSync authorization failed")
    }
  })

  it.each([
    "Command exited with code 1 | build status FAILED | current phase COMPLETED",
    "Insufficient project credit for project project-123. Remaining balance: USD 0. An operator must add credit before deploying.",
    "Insufficient project credit for project project-123. Remaining balance: USD -0.001. An operator must add credit before deploying.",
    "Unable to check project credit for project project-123. Please retry the deployment.",
  ])("surfaces backend deployment failure: %s", async (noisyFailureReason) => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock()

    const fakeEventSource: ExecutionEventSource = {
      close: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          id: "exec-1",
          status: "Running",
          failureReason: null,
          abandonedReason: null,
          finishedAt: null,
          steps: [],
        }
        yield {
          id: "exec-1",
          status: "Failed",
          failureReason: noisyFailureReason,
          abandonedReason: null,
          finishedAt: new Date().toISOString(),
          steps: [
            {
              name: "Execute deployment",
              path: "/deploy",
              status: "Failed",
              failureReason: noisyFailureReason,
            },
          ],
        }
      },
    }

    const error: unknown = await Effect.runPromise(
      (
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createExecutionEventSource: () => Effect.succeed(fakeEventSource),
          },
        )
      ).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toBe(noisyFailureReason)
    }
  })

  it("surfaces persisted AppSync failure reasons alongside progress", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    const detailedFailure =
      "Deployment failed during import.\n❌ Organisation Missing Error:\n   Missing data at SCHOOL_PRINCIPAL_EMAIL"

    const fakeProgressSource: DeployProgressEventSource = {
      close: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "import",
          status: "progress",
          message: "Importing organisation",
          timestamp: new Date().toISOString(),
        }
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "deployment",
          status: "failed",
          message: detailedFailure,
          timestamp: new Date().toISOString(),
        }
      },
    }

    const error: unknown = await Effect.runPromise(
      (
        await runDeployEffect(
          orgPath,
          "project-123",
          "env-456",
          { waitForCompletion: true },
          {
            createDeployProgressEventSource: () =>
              Effect.succeed(fakeProgressSource),
            createExecutionEventSource: () =>
              Effect.succeed(
                executionSource(executionSnapshot("Failed", detailedFailure)),
              ),
          },
        )
      ).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toBe(detailedFailure)
    }
  })

  it("derives AppSync deploy progress subscriptions from baseUrl and access-token userId", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const accessToken = createJwt({
      aud: "graphql-api",
      sub: "sub-user-456",
      properties: {
        userId: "user-123",
      },
    })

    const credentialsPath = createCredentialsFile(
      testDir,
      "https://deploy.example.test",
      new Date(Date.now() + 60_000).toISOString(),
      accessToken,
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    let receivedConfig: DeployProgressEventSourceConfig | undefined

    globalThis.fetch = createDeployFetchMock({
      subscriptionTransportKind: "APPSYNC_EVENTS",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
    })

    const fakeEventSource: DeployProgressEventSource = {
      close: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          version: 1,
          executionId: "exec-1",
          phase: "deployment",
          status: "completed",
          message: "Deployment completed.",
          timestamp: new Date().toISOString(),
        }
      },
    }

    await Effect.runPromise(
      await runDeployEffect(
        orgPath,
        "project-123",
        "env-456",
        { waitForCompletion: true },
        {
          createDeployProgressEventSource: (
            config: DeployProgressEventSourceConfig,
          ) =>
            Effect.sync(() => {
              receivedConfig = config
              return fakeEventSource
            }),
        },
      ),
    )

    expect(receivedConfig).toEqual({
      realtimeUrl: "wss://deploy.example.test/event/realtime",
      appSyncEventsHttpHost: "abc123.appsync-api.us-west-2.amazonaws.com",
      accessToken,
      channel: "/cloud/deploy/user-123/exec-1",
    })
  })

  it.each([
    "https://backend.processfocus.com",
    "https://console.processfocus.com",
  ])(
    "logs standard upload message for standard operator URL %s",
    async (baseUrl) => {
      const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
      tempPaths.push(testDir)

      const orgPath = createTempOrg()
      tempPaths.push(orgPath)

      const credentialsPath = createCredentialsFile(
        testDir,
        baseUrl,
        new Date(Date.now() + 60_000).toISOString(),
      )
      const fakeZipBin = createFakeZip(testDir)

      process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
      process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

      globalThis.fetch = createDeployFetchMock()

      const logs: string[] = []

      const runDeployWithLogsCapture = async () => {
        const modulePath = join(
          WORKSPACE_ROOT,
          "cli/pfcli/src/commands/deploy.ts",
        )
        const module = (await import(modulePath)) as {
          runDeploy: RunDeploy
        }

        const originalConsoleLog = console.log
        console.log = (...args: unknown[]) => {
          logs.push(args.map(String).join(" "))
        }

        try {
          await Effect.runPromise(
            module.runDeploy(
              orgPath,
              "project-123",
              "env-456",
              {
                waitForCompletion: false,
              },
              {
                buildOrg: () => Effect.void,
                prepareArtifact: (_orgPath, artifactPath) =>
                  Effect.sync(() =>
                    writeFileSync(artifactPath, "prepared archive"),
                  ),
              },
            ),
          )
        } finally {
          console.log = originalConsoleLog
        }
      }

      await runDeployWithLogsCapture()

      expect(logs).toContain("Uploading artifact...")
      expect(logs.some((log) => log.includes("Uploading artifact to"))).toBe(
        false,
      )
    },
  )

  it("logs upload message with URL for nonstandard operator URL", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-deploy-test-"))
    tempPaths.push(testDir)

    const orgPath = createTempOrg()
    tempPaths.push(orgPath)

    const credentialsPath = createCredentialsFile(
      testDir,
      "http://mocked.test",
      new Date(Date.now() + 60_000).toISOString(),
    )
    const fakeZipBin = createFakeZip(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["PATH"] = `${fakeZipBin}:${process.env["PATH"] ?? ""}`

    globalThis.fetch = createDeployFetchMock()

    const logs: string[] = []

    const runDeployWithLogsCapture = async () => {
      const modulePath = join(
        WORKSPACE_ROOT,
        "cli/pfcli/src/commands/deploy.ts",
      )
      const module = (await import(modulePath)) as {
        runDeploy: RunDeploy
      }

      const originalConsoleLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }

      try {
        await Effect.runPromise(
          module.runDeploy(
            orgPath,
            "project-123",
            "env-456",
            {
              waitForCompletion: false,
            },
            {
              buildOrg: () => Effect.void,
              prepareArtifact: (_orgPath, artifactPath) =>
                Effect.sync(() =>
                  writeFileSync(artifactPath, "prepared archive"),
                ),
            },
          ),
        )
      } finally {
        console.log = originalConsoleLog
      }
    }

    await runDeployWithLogsCapture()

    expect(logs).toContain("Uploading artifact to http://mocked.test...")
    expect(logs).not.toContain("Uploading artifact...")
  })
})
