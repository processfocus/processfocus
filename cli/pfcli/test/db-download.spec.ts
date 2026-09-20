import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  type SyncDatabaseOpts,
  runDownloadDb,
} from "../src/commands/db/download"
import {
  getFailureMessage,
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

const SQLITE_ENGINE: "libsql" = "libsql"
const databaseDownloadSession = {
  databaseUrl: "libsql://download-db.example.turso.io?authToken=url-secret",
  authToken: "session-secret-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  databaseName: "download-db",
  engine: SQLITE_ENGINE,
  target: {
    projectNumber: "0000-0000-0001",
    environmentName: "dev",
    stageName: "dev",
    databaseName: "download-db",
    tursoOrganization: "pf-test",
  },
}

const unexpectedGraphqlOperation = (query: string): never => {
  throw new Error(`Unexpected GraphQL operation: ${query}`)
}

interface GraphqlBody {
  readonly query: string
  readonly variables: Record<string, unknown>
}

const createGraphqlFetch = (
  handler: (body: GraphqlBody) => Response,
): typeof fetch =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as GraphqlBody

    if (body.query.includes("listProjectEnvironments")) {
      return graphqlResponse({
        listProjectEnvironments: { items: [{ environmentName: "dev" }] },
      })
    }

    return handler(body)
  }) as typeof fetch

describe("pfcli db download", () => {
  const tempPaths: string[] = []
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalCwd = process.cwd()
  const originalLog = console.log
  const originalError = console.error
  const originalFetch = globalThis.fetch

  afterEach(() => {
    process.chdir(originalCwd)
    console.log = originalLog
    console.error = originalError
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

  it("shows a clear error when required download options are missing", async () => {
    const result = await runPfcliInProcess(["db", "download"])

    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain("Missing required download option(s)")
    expect(output).toContain("--project")
    expect(output).toContain("--env")
  })

  it("pulls a database download session into the requested Turso Sync path", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")
    const logs: string[] = []
    const syncEvents: string[] = []
    let syncOptions: SyncDatabaseOpts | undefined
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }

    const fetchImpl = createGraphqlFetch((body) => {
      expect(body.query).not.toContain("startOperationsDownloadDb")
      expect(body.query).not.toContain("databaseDownloadFileId")
      expect(body.query).not.toContain("requestDatabaseDownloadUrl")
      expect(body.query).not.toContain("deleteFile")

      if (body.query.includes("createDatabaseDownloadSession")) {
        expect(body.variables).toEqual({
          projectId: "0000-0000-0001",
          environmentId: "dev",
        })
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const connectSyncDatabase = async (opts: SyncDatabaseOpts) => {
      syncOptions = opts
      return {
        pull: async () => {
          syncEvents.push("pull")
          writeFileSync(outputPath, "synced-bytes")
          return true
        },
        close: async () => {
          syncEvents.push("close")
        },
      }
    }

    const result = await Effect.runPromise(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase,
        fetch: fetchImpl,
      }),
    )

    expect(result).toBe(outputPath)
    expect(readFileSync(outputPath, "utf8")).toBe("synced-bytes")
    expect(syncOptions?.path).toBe(outputPath)
    expect(syncOptions?.url).toBe(databaseDownloadSession.databaseUrl)
    expect(syncOptions?.authToken).toBe(databaseDownloadSession.authToken)
    expect(syncOptions?.fetch).toBe(fetchImpl)
    expect(syncEvents).toEqual(["pull", "close"])
    const logOutput = logs.join("\n")
    expect(logs).toEqual([
      `Downloading download-db (dev)...`,
      `Saved to ${outputPath}`,
    ])
    expect(logOutput).not.toContain('{"message"')
    expect(logOutput).not.toContain("session-secret-token")
    expect(logOutput).not.toContain("authToken=url-secret")
    expect(logOutput).not.toContain("url-secret")
    expect(logOutput).not.toContain(databaseDownloadSession.databaseUrl)
  })

  it("uses the TursoDB materializer selected by authoritative session metadata", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-mvcc-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")
    let connectCalls = 0
    let materializeCalls = 0

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        expect(body.query).toContain("engine")
        return graphqlResponse({
          createDatabaseDownloadSession: {
            ...databaseDownloadSession,
            databaseUrl: "libsql://download-db.example.turso.io/",
            engine: "tursodb",
          },
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromise(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => {
          connectCalls += 1
          throw new Error("sync state must not be opened")
        },
        fetch: fetchImpl,
        materializeTursoDbDownload: (input) =>
          Effect.sync(() => {
            materializeCalls += 1
            expect(input.sourceUrl).toBe(
              "libsql://download-db.example.turso.io/",
            )
            expect(input.authToken).toBe("session-secret-token")
            expect(input.outputPath).toBe(outputPath)
            expect(input.fetch).toBe(fetchImpl)
            writeFileSync(input.outputPath, "materialized-sqlite")
          }),
      }),
    )

    expect(result).toBe(outputPath)
    expect(readFileSync(outputPath, "utf8")).toBe("materialized-sqlite")
    expect(connectCalls).toBe(0)
    expect(materializeCalls).toBe(1)
  })

  it("uses a default filename with project, environment, and timestamp", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-default-"))
    tempPaths.push(testDir)
    process.chdir(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    let syncPath: string | undefined

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: {
            ...databaseDownloadSession,
            target: {
              ...databaseDownloadSession.target,
              projectNumber: "project 123",
            },
          },
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const outputPath = await Effect.runPromise(
      runDownloadDb("project 123", "dev", undefined, {
        connectSyncDatabase: async (opts) => {
          syncPath = opts.path
          return {
            pull: async () => {
              writeFileSync(opts.path, "synced-bytes")
              return true
            },
            close: async () => undefined,
          }
        },
        fetch: fetchImpl,
        now: () => new Date("2026-05-18T12:34:56.000Z"),
      }),
    )

    expect(outputPath).toBe(
      join(testDir, "pfcli-db-project-123-dev-2026-05-18T12-34-56-000Z.sqlite"),
    )
    expect(syncPath).toBe(outputPath)
    expect(readFileSync(outputPath, "utf8")).toBe("synced-bytes")
  })

  it("surfaces Turso Sync pull failures without leaking credentials", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => ({
          pull: async () => {
            throw new Error(
              "remote rejected local sync state for libsql://download-db.example.turso.io?authToken=url-secret",
            )
          },
          close: async () => undefined,
        }),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toBe("Database sync pull failed")
    expect(getFailureMessage(result)).not.toContain("session-secret-token")
    expect(getFailureMessage(result)).not.toContain("authToken=url-secret")
    expect(existsSync(outputPath)).toBe(false)
  })

  it("times out stalled Turso Sync pulls and closes sync state", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-timeout-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")
    const syncEvents: string[] = []

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => ({
          pull: async () => {
            syncEvents.push("pull")
            return await new Promise<boolean>(() => undefined)
          },
          close: async () => {
            syncEvents.push("close")
          },
        }),
        fetch: fetchImpl,
        syncPullTimeoutMs: 1,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toBe("Database sync pull timed out")
    expect(syncEvents).toEqual(["pull", "close"])
  })

  it("surfaces sync state open failures", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-open-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => {
          throw new Error("open failed")
        },
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toBe(
      "Failed to open local database sync state",
    )
  })

  it("fails when sync completes without creating the output file", async () => {
    const testDir = mkdtempSync(
      join(tmpdir(), "pfcli-db-download-missing-file-"),
    )
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromiseExit(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => ({
          pull: async () => false,
          close: async () => undefined,
        }),
        fetch: fetchImpl,
      }),
    )

    expect(result._tag).toBe("Failure")
    expect(getFailureMessage(result)).toBe(
      "Database sync completed without creating output file",
    )
  })

  it("warns without failing when closing sync state fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-close-fail-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")
    const warnings: string[] = []
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromise(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async () => ({
          pull: async () => {
            writeFileSync(outputPath, "synced-bytes")
            return true
          },
          close: async () => {
            throw new Error("close failed")
          },
        }),
        fetch: fetchImpl,
      }),
    )

    expect(result).toBe(outputPath)
    expect(readFileSync(outputPath, "utf8")).toBe("synced-bytes")
    expect(warnings.join("\n")).toContain(
      "Warning: Failed to close local database sync state",
    )
  })

  it("accepts existing output paths and passes them to Turso Sync", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-db-download-exists-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "https://console.example.test",
    )
    const outputPath = join(testDir, "backup.sqlite")
    writeFileSync(outputPath, "existing-sync-state")
    let syncPath: string | undefined
    const logs: string[] = []
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }

    const fetchImpl = createGraphqlFetch((body) => {
      if (body.query.includes("createDatabaseDownloadSession")) {
        return graphqlResponse({
          createDatabaseDownloadSession: databaseDownloadSession,
        })
      }

      return unexpectedGraphqlOperation(body.query)
    })
    globalThis.fetch = fetchImpl

    const result = await Effect.runPromise(
      runDownloadDb("0000-0000-0001", "dev", outputPath, {
        connectSyncDatabase: async (opts) => {
          syncPath = opts.path
          return {
            pull: async () => false,
            close: async () => undefined,
          }
        },
        fetch: fetchImpl,
      }),
    )

    expect(result).toBe(outputPath)
    expect(syncPath).toBe(outputPath)
    expect(readFileSync(outputPath, "utf8")).toBe("existing-sync-state")
    expect(logs).toEqual([
      "Updating local copy download-db (dev)...",
      `Saved to ${outputPath}`,
    ])
  })
})
