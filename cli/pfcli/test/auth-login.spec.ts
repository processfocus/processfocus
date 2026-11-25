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
import { runAuthLogin } from "../src/commands/auth/login"
import * as browser from "../src/utils/open-browser"
import { signedAuthToken } from "./auth-token-fixture"
import {
  captureStdout,
  runPfcliInProcess,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterEach, describe, expect, it, spyOn } from "bun:test"

useSerializedTestState()

interface CredentialsFile {
  readonly version: number
  readonly baseUrl: string
  readonly accessToken: string
  readonly expiresAt: string
  readonly loginAt: string
}

const readCredentialsFile = (path: string): CredentialsFile =>
  JSON.parse(readFileSync(path, "utf8")) as CredentialsFile

describe("pfcli auth login", () => {
  const originalFetch = globalThis.fetch
  const originalCredentialsPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const tempPaths: string[] = []
  const providerToken = signedAuthToken(Date.now() + 7200_000)

  it("rejects retired named-user login without opening a browser", async () => {
    const launch = spyOn(browser, "openBrowser")
    try {
      for (const [env, args] of [
        [{ PFCLI_WORKLOAD_PROVIDER_USER: "user@example.test" }, []],
        [{ PFCLI_CI_PROVIDER_USER: "user@example.test" }, []],
        [
          { PFCLI_WORKLOAD_PROVIDER_USER: undefined },
          ["--ci-provider-user=user@example.test"],
        ],
      ] as const) {
        const { status, output } = await withEnv(
          { ...env, PFCLI_AUTH_MODE: undefined },
          () => runPfcliInProcess(["auth", "login", ...args]),
        )
        expect(status).toBe(1)
        expect(output).toMatch(/retired|ci-provider-user/i)
      }
      expect(launch).not.toHaveBeenCalled()
    } finally {
      launch.mockRestore()
    }
  })

  it.each(["failed", "expired", "success"])(
    "sets the CLI exit status for a %s callback",
    async (outcome) => {
      const tempDir = mkdtempSync(join(tmpdir(), "pfcli-login-status-"))
      tempPaths.push(tempDir)
      const path = join(tempDir, "credentials.json")
      process.env["PFCLI_CREDENTIALS_PATH"] = path
      const launch = spyOn(browser, "openBrowser").mockImplementation((url) =>
        Effect.promise(async () => {
          const loginUrl = new URL(url)
          expect(loginUrl.origin).toBe("http://localhost:3456")
          const params = new URLSearchParams({
            state: loginUrl.searchParams.get("state") ?? "",
          })
          if (outcome === "success") {
            params.set("access_token", providerToken)
            params.set("expires_in", "3600")
          } else {
            params.set("error", outcome)
          }
          const response = await originalFetch(
            `http://localhost:${loginUrl.searchParams.get("port")}/callback?${params}`,
          )
          expect(response.status).toBe(outcome === "success" ? 200 : 400)
          await response.text()
        }),
      )
      try {
        const { status, output } = await withEnv(
          { BASE_URL: "https://ignored.example.com" },
          () =>
            runPfcliInProcess([
              "auth",
              "login",
              "--base-url",
              "http://localhost:3456",
            ]),
        )
        expect(status).toBe(outcome === "success" ? 0 : 1)
        expect(existsSync(path)).toBe(outcome === "success")
        if (outcome === "success")
          expect(readCredentialsFile(path).baseUrl).toBe(
            "http://localhost:3456",
          )
        expect(output).not.toContain(providerToken)
        if (outcome !== "success") {
          expect(output).toContain(`Login failed: Login ${outcome}`)
          expect(output).not.toContain("Login successful")
        }
      } finally {
        launch.mockRestore()
      }
    },
  )

  it.each([
    {
      name: "expired before callback",
      lifetime: 1,
      arrivalDelay: 2000,
      launchDelay: 0,
      jwtLifetime: 1000,
      succeeds: false,
    },
    {
      name: "exact expiry at callback",
      lifetime: 1,
      arrivalDelay: 1000,
      launchDelay: 0,
      jwtLifetime: 1000,
      succeeds: false,
    },
    {
      name: "expired during browser launch",
      lifetime: 1,
      arrivalDelay: 0,
      launchDelay: 2000,
      jwtLifetime: 1000,
      succeeds: false,
    },
    {
      name: "callback deadline expired during browser launch",
      lifetime: 1,
      arrivalDelay: 0,
      launchDelay: 2000,
      jwtLifetime: 10000,
      succeeds: false,
    },
    {
      name: "retains callback deadline",
      lifetime: 10,
      arrivalDelay: 0,
      launchDelay: 2000,
      jwtLifetime: 20000,
      succeeds: true,
    },
    {
      name: "caps delayed credential to JWT deadline",
      lifetime: 10,
      arrivalDelay: 2000,
      launchDelay: 2000,
      jwtLifetime: 10000,
      succeeds: true,
    },
  ])(
    "enforces signed credential deadlines: $name",
    async ({ lifetime, arrivalDelay, launchDelay, jwtLifetime, succeeds }) => {
      const issuedAt = 1800000000000
      let now = issuedAt
      const clock = spyOn(Date, "now").mockImplementation(() => now)
      const accessToken = signedAuthToken(issuedAt + jwtLifetime)
      const tempDir = mkdtempSync(join(tmpdir(), "pfcli-deadline-"))
      tempPaths.push(tempDir)
      const path = join(tempDir, "credentials.json")
      process.env["PFCLI_CREDENTIALS_PATH"] = path
      const previous = "previous credentials"
      writeFileSync(path, previous)
      let callbackStatus = 0
      const launch = spyOn(browser, "openBrowser").mockImplementation((url) =>
        Effect.promise(async () => {
          const loginUrl = new URL(url)
          now += arrivalDelay
          const params = new URLSearchParams({
            state: loginUrl.searchParams.get("state") ?? "",
            access_token: accessToken,
            expires_in: String(lifetime),
          })
          const response = await originalFetch(
            `http://localhost:${loginUrl.searchParams.get("port")}/callback?${params}`,
          )
          callbackStatus = response.status
          await response.text()
          now += launchDelay
        }),
      )
      try {
        const { output } = await captureStdout(async () => {
          const login = Effect.runPromise(runAuthLogin("https://example.com"))
          if (succeeds) await login
          else await expect(login).rejects.toThrow("Login expired")
        })
        expect(callbackStatus).toBe(arrivalDelay >= jwtLifetime ? 400 : 200)
        expect(output).not.toContain(accessToken)
        expect(output.includes("Login successful! Credentials stored.")).toBe(
          succeeds,
        )
        if (succeeds) {
          expect(Date.parse(readCredentialsFile(path).expiresAt)).toBe(
            Math.min(
              issuedAt + arrivalDelay + lifetime * 1000,
              issuedAt + jwtLifetime,
            ),
          )
        } else {
          expect(readFileSync(path, "utf8")).toBe(previous)
        }
      } finally {
        launch.mockRestore()
        clock.mockRestore()
      }
    },
  )

  it.each(["human", "near-expiry", "failed", "expired", "invalid-lifetime"])(
    "handles the real browser callback and storage: %s",
    async (scenario) => {
      const tempDir = mkdtempSync(join(tmpdir(), "pfcli-browser-login-"))
      tempPaths.push(tempDir)
      const credentialsPath = join(tempDir, "credentials.json")
      process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
      const succeeds = scenario === "human" || scenario === "near-expiry"
      const accessToken = signedAuthToken(Date.now() + 28800_000)
      const existing = "existing credentials must not be replaced"
      if (scenario === "expired") writeFileSync(credentialsPath, existing)
      let callbackUrl = ""
      const launch = spyOn(browser, "openBrowser").mockImplementation((url) =>
        Effect.promise(async () => {
          const loginUrl = new URL(url)
          expect(loginUrl.pathname).toBe("/cli-auth")
          const state = loginUrl.searchParams.get("state")
          expect(state).toBeTruthy()
          const params = new URLSearchParams({ state: state ?? "" })
          if (scenario === "failed" || scenario === "expired") {
            params.set("error", scenario)
            params.set("error_description", "secret-value")
          } else {
            params.set("access_token", accessToken)
            params.set(
              "expires_in",
              scenario === "invalid-lifetime"
                ? "0"
                : scenario === "near-expiry"
                  ? "0.25"
                  : "28800",
            )
          }
          callbackUrl = `http://localhost:${loginUrl.searchParams.get("port")}/callback?${params}`
          const response = await originalFetch(callbackUrl)
          expect(response.status).toBe(succeeds ? 200 : 400)
          expect(await response.text()).not.toContain("secret-value")
        }),
      )
      try {
        const { output } = await captureStdout(async () => {
          const login = Effect.runPromise(runAuthLogin("https://example.com"))
          if (succeeds) await login
          else
            await expect(login).rejects.toThrow(
              scenario === "invalid-lifetime"
                ? "Invalid login credential lifetime"
                : `Login ${scenario}`,
            )
        })
        expect(output).not.toContain("secret-value")
        expect(output.includes("Login successful! Credentials stored.")).toBe(
          succeeds,
        )
        if (succeeds) {
          expect(readCredentialsFile(credentialsPath).accessToken).toBe(
            accessToken,
          )
        } else if (scenario === "expired") {
          expect(readFileSync(credentialsPath, "utf8")).toBe(existing)
        } else {
          expect(existsSync(credentialsPath)).toBe(false)
        }
        await expect(originalFetch(callbackUrl)).rejects.toThrow()
      } finally {
        launch.mockRestore()
      }
    },
  )

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const path of tempPaths) {
      rmSync(path, { recursive: true, force: true })
    }
    tempPaths.length = 0

    if (originalCredentialsPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredentialsPath
    }
  })
})
