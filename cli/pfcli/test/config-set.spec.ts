import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { parseConfigSetAssignment } from "../src/commands/config/set"
import {
  captureStdout,
  loadPfcliCommand,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

type RunConfigSet = (
  projectId: string,
  stageId: string,
  args: ReadonlyArray<string>,
  isSecret: boolean,
) => Effect.Effect<void, unknown>

const loadConfigSetCommand = () =>
  loadPfcliCommand<{
    runConfigSet: RunConfigSet
  }>("config/set")

const isCliError = (
  value: unknown,
): value is { readonly _tag: "CliError"; readonly message: string } =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "CliError" &&
  "message" in value &&
  typeof value.message === "string"

const createCredentialsFile = (baseDir: string, baseUrl: string) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      version: 1,
      baseUrl,
      accessToken: "test-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      loginAt: new Date().toISOString(),
    }),
  )
  return credentialsPath
}

useSerializedTestState()

describe("pfcli config set", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredentialsPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalTestValue = process.env["PFCLI_CONFIG_SET_TEST_VALUE"]

  afterEach(() => {
    for (const tempPath of tempPaths) {
      rmSync(tempPath, { recursive: true, force: true })
    }
    tempPaths.length = 0
    globalThis.fetch = originalFetch
    if (originalCredentialsPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredentialsPath
    }
    if (originalTestValue === undefined) {
      delete process.env["PFCLI_CONFIG_SET_TEST_VALUE"]
    } else {
      process.env["PFCLI_CONFIG_SET_TEST_VALUE"] = originalTestValue
    }
  })

  it("reads the value of a bare key from the environment", async () => {
    const result = await Effect.runPromise(
      parseConfigSetAssignment(["API_URL"], {
        API_URL: "https://example.com",
      }),
    )

    expect(result).toEqual(["API_URL", "https://example.com"])
  })

  it("accepts an environment variable set to an empty string", async () => {
    const result = await Effect.runPromise(
      parseConfigSetAssignment(["EMPTY_VALUE"], { EMPTY_VALUE: "" }),
    )

    expect(result).toEqual(["EMPTY_VALUE", ""])
  })

  it("fails before any GraphQL call when a bare key is unset", async () => {
    delete process.env["PFCLI_CONFIG_SET_TEST_VALUE"]
    let fetchCalled = false
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalled = true
        throw new Error("fetch should not be called")
      },
      { preconnect: originalFetch.preconnect },
    )

    const { runConfigSet } = await loadConfigSetCommand()
    const error: unknown = await Effect.runPromise(
      runConfigSet(
        "0000-0000-0002",
        "Development",
        ["PFCLI_CONFIG_SET_TEST_VALUE"],
        false,
      ).pipe(Effect.flip),
    )

    expect(fetchCalled).toBe(false)
    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error._tag).toBe("CliError")
      expect(error.message).toBe(
        "Environment variable PFCLI_CONFIG_SET_TEST_VALUE is unset",
      )
    }
  })

  it("keeps using the value supplied with an equals sign", async () => {
    const result = await Effect.runPromise(
      parseConfigSetAssignment(["API_URL=explicit"], {
        API_URL: "environment",
      }),
    )

    expect(result).toEqual(["API_URL", "explicit"])
  })

  it("keeps an empty value supplied with an equals sign", async () => {
    const result = await Effect.runPromise(
      parseConfigSetAssignment(["API_URL="], { API_URL: "environment" }),
    )

    expect(result).toEqual(["API_URL", ""])
  })

  it("keeps using the separately supplied value", async () => {
    const result = await Effect.runPromise(
      parseConfigSetAssignment(["API_URL", "explicit"], {
        API_URL: "environment",
      }),
    )

    expect(result).toEqual(["API_URL", "explicit"])
  })

  it("documents all three forms in the usage error", async () => {
    const error: unknown = await Effect.runPromise(
      parseConfigSetAssignment([], {}).pipe(Effect.flip),
    )

    expect(isCliError(error)).toBe(true)
    if (isCliError(error)) {
      expect(error.message).toContain("KEY'")
      expect(error.message).toContain("KEY=VALUE")
      expect(error.message).toContain("KEY VALUE")
    }
  })

  it("copies a bare environment value into a secret config parameter without logging it", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-config-set-"))
    tempPaths.push(testDir)
    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )
    process.env["PFCLI_CONFIG_SET_TEST_VALUE"] = "not-for-logs"

    let stageLookupCalled = false
    let mutationCalled = false
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const requestBody = String(init?.body)

        if (requestBody.includes("HostingContract")) {
          return new Response(
            JSON.stringify({ errors: [{ message: "Not available in test" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }

        const body: unknown = JSON.parse(requestBody)
        if (requestBody.includes("ListProjectStages")) {
          stageLookupCalled = true
          expect(body).toEqual({
            query: expect.stringContaining("ListProjectStages"),
            variables: { projectId: "0000-0000-0002" },
          })
          return new Response(
            JSON.stringify({
              data: {
                listProjectStages: {
                  items: [{ stageName: "Development" }],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }

        expect(body).toEqual({
          query: expect.stringContaining("SetConfigParameter"),
          variables: {
            projectId: "0000-0000-0002",
            stageId: "Development",
            key: "PFCLI_CONFIG_SET_TEST_VALUE",
            value: "not-for-logs",
            isSecret: true,
          },
        })
        mutationCalled = true
        return new Response(
          JSON.stringify({ data: { setConfigParameter: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      },
      { preconnect: originalFetch.preconnect },
    )

    const { runConfigSet } = await loadConfigSetCommand()
    const { output } = await captureStdout(() =>
      Effect.runPromise(
        runConfigSet(
          "0000-0000-0002",
          "Development",
          ["PFCLI_CONFIG_SET_TEST_VALUE"],
          true,
        ),
      ),
    )

    expect(stageLookupCalled).toBe(true)
    expect(mutationCalled).toBe(true)
    expect(output).toContain(
      "Setting config parameter PFCLI_CONFIG_SET_TEST_VALUE (secret)",
    )
    expect(output).toContain("Successfully set PFCLI_CONFIG_SET_TEST_VALUE")
    expect(output).not.toContain("not-for-logs")
  })
})
