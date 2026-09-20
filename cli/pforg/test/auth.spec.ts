import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import { afterEach, describe, expect, test } from "bun:test"

const PFORG = resolve(import.meta.dir, "../src/main.ts")
const ACCESS_TOKEN = "pforg-test-access-token"
const INVALID_CREDENTIAL_CASES: ReadonlyArray<
  readonly [caseName: string, expiresAt: string | undefined]
> = [
  ["missing", undefined],
  ["expired", "2000-01-01T00:00:00.000Z"],
]

const CredentialsSchema = Schema.Struct({
  version: Schema.Literal(1),
  baseUrl: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.String,
  loginAt: Schema.String,
})

type EnvironmentOverrides = Readonly<Record<string, string | undefined>>

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const commandEnvironment = (
  overrides: EnvironmentOverrides,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries({
    ...process.env,
    ...overrides,
  })) {
    if (value !== undefined) environment[name] = value
  }
  return environment
}

const runPforg = async (
  args: readonly string[],
  environment: EnvironmentOverrides = {},
): Promise<CommandResult> => {
  const subprocess = Bun.spawn([process.execPath, PFORG, ...args], {
    env: commandEnvironment(environment),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return { stdout, stderr, exitCode }
}

const writeBrowserOpener = (root: string): string => {
  const fakeBin = join(root, "bin")
  const opener = join(fakeBin, "xdg-open")
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(
    opener,
    [
      "#!/usr/bin/env bun",
      'import { writeFileSync } from "node:fs"',
      "",
      'const loginUrl = new URL(process.argv[2] ?? "")',
      'const capturePath = process.env["PFORG_TEST_BROWSER_URL_PATH"]',
      'if (!capturePath) throw new Error("Missing browser URL capture path")',
      "writeFileSync(capturePath, loginUrl.toString())",
      "",
      'const port = loginUrl.searchParams.get("port")',
      'const state = loginUrl.searchParams.get("state")',
      'if (!port || !state) throw new Error("Missing callback parameters")',
      "",
      'const callbackUrl = new URL("http://localhost:" + port + "/callback")',
      `callbackUrl.searchParams.set("access_token", ${JSON.stringify(ACCESS_TOKEN)})`,
      'callbackUrl.searchParams.set("expires_in", "3600")',
      'callbackUrl.searchParams.set("state", state)',
      "",
      "const response = await fetch(callbackUrl)",
      'if (!response.ok) throw new Error("Callback failed: " + response.status)',
      "",
    ].join("\n"),
  )
  chmodSync(opener, 0o755)
  return fakeBin
}

const readCredentials = (path: string) => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  return Schema.decodeUnknownSync(CredentialsSchema)(parsed)
}

const writeTestCredentials = (
  path: string,
  values: { readonly expiresAt: string; readonly accessToken?: string },
) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: "https://org.example.test",
      accessToken: values.accessToken ?? ACCESS_TOKEN,
      expiresAt: values.expiresAt,
      loginAt: "2026-08-29T00:00:00.000Z",
    }),
  )
}

describe("pforg auth", () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths) {
      rmSync(path, { recursive: true, force: true })
    }
    tempPaths.length = 0
  })

  test("login requires an explicit base URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "pforg-required-url-"))
    tempPaths.push(root)

    const result = await runPforg(["auth", "login"], {
      HOME: root,
      PFORG_CREDENTIALS_PATH: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
    expect(existsSync(join(root, ".config", "pforg", "credentials.json"))).toBe(
      false,
    )
  })

  test("login uses the Dashboard flow and writes isolated secure credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "pforg-login-"))
    tempPaths.push(root)
    const home = join(root, "home")
    const capturedBrowserUrl = join(root, "browser-url")
    const pfcliCredentials = join(root, "pfcli-credentials.json")
    const fakeBin = writeBrowserOpener(root)
    mkdirSync(home)
    writeFileSync(pfcliCredentials, "pfcli credentials stay unchanged")

    const baseUrl = "https://org.example.test"
    const result = await runPforg(["auth", "login", baseUrl], {
      HOME: home,
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      PFCLI_CREDENTIALS_PATH: pfcliCredentials,
      PFORG_CREDENTIALS_PATH: undefined,
      PFORG_TEST_BROWSER_URL_PATH: capturedBrowserUrl,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)

    const loginUrl = new URL(readFileSync(capturedBrowserUrl, "utf8"))
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe(
      "https://org.example.test/cli-auth",
    )
    expect(Number(loginUrl.searchParams.get("port"))).toBeGreaterThan(0)
    expect(loginUrl.searchParams.get("state")).not.toBeNull()

    const credentialsDirectory = join(home, ".config", "pforg")
    const credentialsPath = join(credentialsDirectory, "credentials.json")
    const credentials = readCredentials(credentialsPath)
    expect(credentials).toMatchObject({
      version: 1,
      baseUrl,
      accessToken: ACCESS_TOKEN,
    })
    expect(Object.keys(credentials).toSorted()).toEqual([
      "accessToken",
      "baseUrl",
      "expiresAt",
      "loginAt",
      "version",
    ])
    expect(Date.parse(credentials.expiresAt)).toBeGreaterThan(Date.now())
    expect(statSync(credentialsDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(pfcliCredentials, "utf8")).toBe(
      "pfcli credentials stay unchanged",
    )
  })

  test("login honors PFORG_CREDENTIALS_PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "pforg-custom-login-"))
    tempPaths.push(root)
    const fakeBin = writeBrowserOpener(root)
    const credentialsPath = join(root, "custom", "credentials.json")

    const result = await runPforg(["auth", "login", "http://localhost:3000"], {
      HOME: join(root, "unused-home"),
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      PFORG_CREDENTIALS_PATH: credentialsPath,
      PFORG_TEST_BROWSER_URL_PATH: join(root, "browser-url"),
    })

    expect(result.exitCode).toBe(0)
    expect(readCredentials(credentialsPath).baseUrl).toBe(
      "http://localhost:3000",
    )
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
  })

  test("status prints only the base URL and expiry", async () => {
    const root = mkdtempSync(join(tmpdir(), "pforg-status-"))
    tempPaths.push(root)
    const credentialsPath = join(root, "credentials.json")
    const expiresAt = "2999-08-29T01:02:03.000Z"
    writeTestCredentials(credentialsPath, { expiresAt })

    const result = await runPforg(["auth", "status"], {
      PFORG_CREDENTIALS_PATH: credentialsPath,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(
      `Base URL: https://org.example.test\nExpires at: ${expiresAt}`,
    )
    expect(result.stdout).not.toContain(ACCESS_TOKEN)
    expect(result.stderr).not.toContain(ACCESS_TOKEN)
  })

  test.each(INVALID_CREDENTIAL_CASES)(
    "%s credentials ask the user to log in and exit 1",
    async (_case, expiresAt) => {
      const root = mkdtempSync(join(tmpdir(), "pforg-invalid-status-"))
      tempPaths.push(root)
      const credentialsPath = join(root, "credentials.json")
      if (expiresAt) writeTestCredentials(credentialsPath, { expiresAt })

      const result = await runPforg(["auth", "status"], {
        PFORG_CREDENTIALS_PATH: credentialsPath,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("pforg auth login")
      expect(result.stdout).not.toContain(ACCESS_TOKEN)
      expect(result.stderr).not.toContain(ACCESS_TOKEN)
    },
  )
})
