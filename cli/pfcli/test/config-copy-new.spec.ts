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

type RunConfigCopyNew = (
  projectId: string,
  stageId: string,
  fromStageId: string,
) => Effect.Effect<void, unknown>

const loadRunConfigCopyNew = async (): Promise<RunConfigCopyNew> => {
  const module = await loadPfcliCommand<{
    runConfigCopyNew: RunConfigCopyNew
  }>("config/copy-new")

  return module.runConfigCopyNew
}

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

useSerializedTestState()

describe("pfcli config copy-new", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  const isCliError = (
    value: unknown,
  ): value is { _tag: string; message: string } =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    "message" in value

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

  it("calls the copy-new mutation and prints copied keys", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-config-copy-new-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: {
          projectId?: string
          stageId?: string
          fromStageId?: string
        }
      }

      expect(body.query).toContain("copyNewConfigParameters")
      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
        stageId: "Production",
        fromStageId: "Development",
      })

      return new Response(
        JSON.stringify({
          data: {
            copyNewConfigParameters: {
              copiedCount: 2,
              copiedKeys: ["API_TOKEN", "GOOGLE_CLIENT_ID"],
              sameStage: false,
              skippedCount: 1,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runConfigCopyNew = await loadRunConfigCopyNew()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runConfigCopyNew("0000-0000-0002", "Production", "Development"),
      ),
    )

    expect(output).toContain(
      "Copied 2 new config parameters from Development to Production.",
    )
    expect(output).toContain("Skipped 1 existing key.")
    expect(output).toContain("API_TOKEN")
    expect(output).toContain("GOOGLE_CLIENT_ID")
  })

  it("prints a source-empty message when there is nothing to copy", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-config-copy-new-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            copyNewConfigParameters: {
              copiedCount: 0,
              copiedKeys: [],
              sameStage: false,
              skippedCount: 0,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runConfigCopyNew = await loadRunConfigCopyNew()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runConfigCopyNew("0000-0000-0002", "Production", "Development"),
      ),
    )

    expect(output).toContain("No config parameters found in Development.")
  })

  it("warns and skips immediately when source and destination flags are equal", async () => {
    const runConfigCopyNew = await loadRunConfigCopyNew()
    let fetchCalled = false

    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runConfigCopyNew("0000-0000-0002", "Production", "Production"),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toContain(
      "Source and destination stage are both Production. Nothing copied.",
    )
  })

  it("surfaces GraphQL errors as a deploy failure", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-config-copy-new-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Resolver exploded" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runConfigCopyNew = await loadRunConfigCopyNew()
    const error: unknown = await Effect.runPromise(
      runConfigCopyNew("0000-0000-0002", "Production", "Development").pipe(
        Effect.flip,
      ),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error._tag).toBe("CliError")
      expect(error.message).toBe("GraphQL error: Resolver exploded")
    }
  })
})
