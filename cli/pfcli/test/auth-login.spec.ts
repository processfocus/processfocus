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
  const originalCiPipelineSecret = process.env["CI_PIPELINE_SECRET"]
  const originalCredentialsPath = process.env["PFCLI_CREDENTIALS_PATH"]
  const originalWorkspaceRoot = process.env["NX_WORKSPACE_ROOT"]
  const tempPaths: string[] = []
  const baseToken = signedAuthToken(Date.now() + 3600_000)
  const providerToken = signedAuthToken(Date.now() + 7200_000)

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
        const { status, output } = await runPfcliInProcess(["auth", "login"])
        expect(status).toBe(outcome === "success" ? 0 : 1)
        expect(existsSync(path)).toBe(outcome === "success")
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

    if (originalCiPipelineSecret === undefined) {
      delete process.env["CI_PIPELINE_SECRET"]
    } else {
      process.env["CI_PIPELINE_SECRET"] = originalCiPipelineSecret
    }

    if (originalCredentialsPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredentialsPath
    }

    if (originalWorkspaceRoot === undefined) {
      delete process.env["NX_WORKSPACE_ROOT"]
    } else {
      process.env["NX_WORKSPACE_ROOT"] = originalWorkspaceRoot
    }
  })

  it("can log in as a CI provider user and write normal credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pfcli-auth-login-"))
    tempPaths.push(tempDir)
    const credentialsPath = join(tempDir, "credentials.json")
    const baseUrl = "https://dev.console.processfocus.com"
    const secret = "test-ci-secret"
    const expectedAuthorization = `Basic ${Buffer.from(`ci-pipeline:${secret}`).toString("base64")}`
    const tokenRequests: string[] = []

    process.env["CI_PIPELINE_SECRET"] = secret
    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get("authorization")

      if (url === `${baseUrl}/oauth/token`) {
        expect(authorization).toBe(expectedAuthorization)
        const body = String(init?.body)
        tokenRequests.push(body)

        if (body === "grant_type=client_credentials") {
          return new Response(
            JSON.stringify({ access_token: baseToken, expires_in: 3600 }),
            { headers: { "Content-Type": "application/json" } },
          )
        }

        expect(body).toBe(
          "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
        )
        return new Response(
          JSON.stringify({ access_token: providerToken, expires_in: 7200 }),
          { headers: { "Content-Type": "application/json" } },
        )
      }

      expect(url).toBe(`${baseUrl}/graphql`)
      expect(authorization).toBe(`Bearer ${baseToken}`)

      const body = JSON.parse(String(init?.body)) as {
        readonly variables?: { readonly email?: string }
      }
      expect(body.variables?.email).toBe("e2e-admin@example.com")

      return new Response(
        JSON.stringify({
          data: {
            requestProviderUserPermissions: { success: true, error: null },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    await Effect.runPromise(
      runAuthLogin(baseUrl, { ciProviderUser: "e2e-admin@example.com" }),
    )

    expect(tokenRequests).toEqual([
      "grant_type=client_credentials",
      "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
    ])
    const credentials = readCredentialsFile(credentialsPath)
    expect(credentials).toMatchObject({
      version: 1,
      baseUrl,
      accessToken: providerToken,
    })
    expect(new Date(credentials.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    )
  })

  it("retries transient auth server 5xx token responses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pfcli-auth-login-retry-"))
    tempPaths.push(tempDir)
    const credentialsPath = join(tempDir, "credentials.json")
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    const tokenRequests: string[] = []

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).endsWith("/oauth/token")) {
        const body = String(init?.body)
        tokenRequests.push(body)

        if (
          body === "grant_type=client_credentials" &&
          tokenRequests.length === 1
        ) {
          return new Response("Internal Server Error", { status: 500 })
        }

        return new Response(
          JSON.stringify({
            access_token:
              body === "grant_type=client_credentials"
                ? baseToken
                : providerToken,
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }

      return Response.json({
        data: {
          requestProviderUserPermissions: { success: true, error: null },
        },
      })
    }) as typeof fetch

    await Effect.runPromise(
      runAuthLogin("https://dev.console.processfocus.com", {
        ciProviderUser: "e2e-admin@example.com",
      }),
    )

    expect(tokenRequests).toEqual([
      "grant_type=client_credentials",
      "grant_type=client_credentials",
      "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
    ])
    expect(readCredentialsFile(credentialsPath).accessToken).toBe(providerToken)
  })

  it("reports persistent transient auth server failures after retries", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
    let tokenRequestCount = 0

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth/token")) {
        tokenRequestCount += 1
        return new Response("Internal Server Error", { status: 500 })
      }

      return Response.json({
        data: {
          requestProviderUserPermissions: { success: true, error: null },
        },
      })
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow(
      "OAuth token request kept failing: OAuth token endpoint returned HTTP 500: Internal Server Error",
    )
    expect(tokenRequestCount).toBe(6)
  })

  it("keeps server_error diagnostics after retries are exhausted", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
    let tokenRequestCount = 0
    const body = JSON.stringify({
      error: "server_error",
      error_description: "Database connection pool exhausted",
    })

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth/token")) {
        tokenRequestCount += 1
        // Non-5xx so this exercises the parsed server_error branch, not the
        // plain-text 5xx path above it.
        return new Response(body, {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      return Response.json({
        data: {
          requestProviderUserPermissions: { success: true, error: null },
        },
      })
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow(
      'OAuth token request kept failing: OAuth token endpoint returned HTTP 400 server_error: Database connection pool exhausted ({"error":"server_error","error_description":"Database connection pool exhausted"})',
    )
    expect(tokenRequestCount).toBe(6)
  })

  it("does not retry OAuth client credential errors", async () => {
    process.env["CI_PIPELINE_SECRET"] = "wrong-ci-secret"
    let tokenRequestCount = 0

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth/token")) {
        tokenRequestCount += 1
        return new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: "Invalid client credentials",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        )
      }

      return Response.json({
        data: {
          requestProviderUserPermissions: { success: true, error: null },
        },
      })
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow("invalid_client: Invalid client credentials")
    expect(tokenRequestCount).toBe(1)
  })

  it.each([0, -1, 1e300, 1e-300])(
    "does not store a CI credential with invalid lifetime %s",
    async (expiresIn) => {
      const tempDir = mkdtempSync(join(tmpdir(), "pfcli-invalid-lifetime-"))
      tempPaths.push(tempDir)
      const credentialsPath = join(tempDir, "credentials.json")
      process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
      process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (String(input).endsWith("/graphql")) {
          return Response.json({
            data: { requestProviderUserPermissions: { success: true } },
          })
        }
        return Response.json({
          access_token: providerToken,
          expires_in: String(init?.body).includes("scope=") ? expiresIn : 3600,
        })
      }) as typeof fetch
      const { output } = await captureStdout(async () => {
        await expect(
          Effect.runPromise(
            runAuthLogin("https://example.com", {
              ciProviderUser: "user@example.com",
            }),
          ),
        ).rejects.toThrow()
      })
      expect(existsSync(credentialsPath)).toBe(false)
      expect(output).not.toContain("Login successful")
      expect(output).not.toContain("secret-value")
    },
  )

  it("fails the CI provider-user path when CI_PIPELINE_SECRET is missing", async () => {
    delete process.env["CI_PIPELINE_SECRET"]

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow(
      "CI_PIPELINE_SECRET environment variable is required for --ci-provider-user",
    )
  })

  it("fails the CI provider-user path when email is empty", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "   ",
        }),
      ),
    ).rejects.toThrow("--ci-provider-user must not be empty")
  })

  it("reports provider-user permission denial errors", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://dev.console.processfocus.com/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: baseToken, expires_in: 3600 }),
          { headers: { "Content-Type": "application/json" } },
        )
      }

      expect(url).toBe("https://dev.console.processfocus.com/graphql")
      return new Response(
        JSON.stringify({
          data: {
            requestProviderUserPermissions: {
              success: false,
              error: "Provider user not found",
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "missing@example.com",
        }),
      ),
    ).rejects.toThrow("Provider user not found")
  })

  it("reports structured OAuth token errors", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"

    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://dev.console.processfocus.com/oauth/token",
      )
      return new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "Bad client secret",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow(
      "OAuth token request failed: invalid_client: Bad client secret",
    )
  })

  it("reports scoped provider-user token errors", async () => {
    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
    const tokenRequests: string[] = []

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)

      if (url === "https://dev.console.processfocus.com/oauth/token") {
        const body = String(init?.body)
        tokenRequests.push(body)

        if (body === "grant_type=client_credentials") {
          return new Response(
            JSON.stringify({ access_token: baseToken, expires_in: 3600 }),
            { headers: { "Content-Type": "application/json" } },
          )
        }

        expect(body).toBe(
          "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
        )
        return new Response(
          JSON.stringify({
            error: "invalid_scope",
            error_description: "Provider user scope denied",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      }

      expect(url).toBe("https://dev.console.processfocus.com/graphql")
      return new Response(
        JSON.stringify({
          data: {
            requestProviderUserPermissions: { success: true, error: null },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    await expect(
      Effect.runPromise(
        runAuthLogin("https://dev.console.processfocus.com", {
          ciProviderUser: "e2e-admin@example.com",
        }),
      ),
    ).rejects.toThrow(
      "OAuth token request failed: invalid_scope: Provider user scope denied",
    )
    expect(tokenRequests).toEqual([
      "grant_type=client_credentials",
      "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
    ])
  })

  it("uses local auth and GraphQL default ports when port files are missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pfcli-auth-login-local-"))
    tempPaths.push(tempDir)
    const credentialsPath = join(tempDir, "credentials.json")
    const tokenRequests: string[] = []

    process.env["CI_PIPELINE_SECRET"] = "test-ci-secret"
    process.env["PFCLI_CREDENTIALS_PATH"] = credentialsPath
    process.env["NX_WORKSPACE_ROOT"] = tempDir

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)

      if (url === "http://localhost:4020/oauth/token") {
        const body = String(init?.body)
        tokenRequests.push(body)
        return new Response(
          JSON.stringify({
            access_token:
              body === "grant_type=client_credentials"
                ? baseToken
                : providerToken,
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      }

      expect(url).toBe("http://localhost:4000/graphql")
      return new Response(
        JSON.stringify({
          data: {
            requestProviderUserPermissions: { success: true, error: null },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    await Effect.runPromise(
      runAuthLogin("http://localhost:3000", {
        ciProviderUser: "e2e-admin@example.com",
      }),
    )

    expect(tokenRequests).toEqual([
      "grant_type=client_credentials",
      "grant_type=client_credentials&scope=email%3Ae2e-admin%40example.com",
    ])
    const credentials = readCredentialsFile(credentialsPath)
    expect(credentials.accessToken).toBe(providerToken)
  })
})
