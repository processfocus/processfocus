import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  ensureKnownEnvironmentName,
  ensureKnownStageNames,
} from "../src/utils/remote-name-validation"
import { useSerializedTestState } from "./test-helpers"
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

describe("remote name validation", () => {
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

  it("fails with a suggested environment and known list", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-remote-name-validation-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: {
              items: [
                { environmentName: "dev" },
                { environmentName: "production" },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    await expect(
      Effect.runPromise(
        ensureKnownEnvironmentName("0000-0000-0002", "prodution"),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Unknown environment "prodution" for project 0000-0000-0002.',
      ),
    })

    await expect(
      Effect.runPromise(
        ensureKnownEnvironmentName("0000-0000-0002", "prodution"),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Did you mean "production"?'),
    })
  })

  it("does not treat a malformed env-prefixed value as an internal ID", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-remote-name-validation-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: {
              items: [{ environmentName: "dev" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    await expect(
      Effect.runPromise(
        ensureKnownEnvironmentName("0000-0000-0002", "env-foo"),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Unknown environment "env-foo"'),
    })
  })

  it("shows possible stage matches when the best score ties", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-remote-name-validation-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            listProjectStages: {
              items: [
                { stageName: "Developmenx" },
                { stageName: "Developmeny" },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    await expect(
      Effect.runPromise(
        ensureKnownStageNames("0000-0000-0002", ["Development"]),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Unknown stage "Development" for project 0000-0000-0002.',
      ),
    })

    await expect(
      Effect.runPromise(
        ensureKnownStageNames("0000-0000-0002", ["Development"]),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Possible matches: Developmenx, Developmeny",
      ),
    })
  })

  it("falls back cleanly when the validation lookup fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-remote-name-validation-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    await expect(
      Effect.runPromise(ensureKnownEnvironmentName("0000-0000-0002", "prod")),
    ).resolves.toBeUndefined()
  })
})
