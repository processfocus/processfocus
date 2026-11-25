import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { runDownloadDb } from "../src/commands/db/download"
import { runUploadDb } from "../src/commands/db/upload"
import type { CliError } from "../src/errors"
import { useSerializedTestState, withEnv } from "./test-helpers"
import { expect, it } from "bun:test"

useSerializedTestState()

// The issuer is a protocol fixture here; real issuer renewal is covered by
// workload-deploy.slow.spec.ts. This protects transfer cancellation and no apply.
it.each(["download", "upload"])(
  "stops workload %s at capability expiry without applying",
  async (direction) => {
    const root = mkdtempSync(join(tmpdir(), "workload-transfer-"))
    const file = join(root, "transfer.sqlite")
    writeFileSync(file, "SQLite format 3\0test")
    const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.signature`
    let applies = 0
    let transferStarted = false
    let closed = false
    const server = Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/github") return Response.json({ value: token })
        if (url.pathname === "/oauth/token")
          return Response.json({
            access_token: token,
            expires_in: 300,
            token_type: "Bearer",
          })
        const body = await request.text()
        const expiresAt = new Date(Date.now() + 150).toISOString()
        if (body.includes("StartUploadDb")) applies++
        const data = body.includes("ListProjectEnvironments")
          ? { listProjectEnvironments: { items: [{ environmentName: "dev" }] } }
          : body.includes("CreateDatabaseDownloadSession")
            ? {
                createDatabaseDownloadSession: {
                  databaseUrl: "libsql://fixture.invalid",
                  authToken: "bounded",
                  databaseName: "test",
                  engine: "libsql",
                  target: { stageName: "dev" },
                  expiresAt,
                },
              }
            : body.includes("RequestDatabaseUploadUrl")
              ? {
                  requestDatabaseUploadUrl: {
                    operationId: "op",
                    fileId: "file",
                    documentStore: "/database-transfer",
                    uploadUrl: "https://fixture.invalid/upload",
                    expiresAt,
                    status: "READY_FOR_UPLOAD",
                  },
                }
              : {}
        return Response.json({ data })
      },
    })
    const baseUrl = `http://127.0.0.2:${server.port}`
    try {
      await withEnv(
        {
          PFCLI_AUTH_MODE: "github-workload",
          PFCLI_BASE_URL: baseUrl,
          PFCLI_GITHUB_AUDIENCE: "transfer-test",
          PFCLI_WORKLOAD_PROVIDER_USER: undefined,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${baseUrl}/github`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "job",
          CI_PIPELINE_SECRET: "unused",
        },
        async () => {
          const transfer: Effect.Effect<unknown, CliError> =
            direction === "download"
              ? runDownloadDb("project", "dev", file, {
                  connectSyncDatabase: async () => ({
                    pull: async () => {
                      transferStarted = true
                      return await new Promise<boolean>(() => {})
                    },
                    close: async () => {
                      closed = true
                    },
                  }),
                })
              : runUploadDb("project", "dev", file, {
                  fetch: Object.assign(
                    async (
                      _input: string | URL | Request,
                      init?: RequestInit,
                    ) => {
                      transferStarted = true
                      return await new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener(
                          "abort",
                          () => {
                            closed = true
                            reject(new Error("aborted"))
                          },
                          { once: true },
                        )
                      })
                    },
                    { preconnect: fetch.preconnect },
                  ),
                })
          await expect(Effect.runPromise(transfer)).rejects.toThrow(
            "Database transfer capability expired",
          )
          expect(transferStarted).toBe(true)
          expect(closed).toBe(true)
          expect(applies).toBe(0)
        },
      )
    } finally {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  },
)
