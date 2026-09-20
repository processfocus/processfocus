import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CLI_ORGANISATION_SDK_VERSION } from "../src/package-metadata"
import Database from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"

const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..")
const PFCLI = join(WORKSPACE_ROOT, "cli/pfcli/src/main.ts")

const findPackedTarball = (directory: string, packagePrefix: string) => {
  const packageDirectory = join(WORKSPACE_ROOT, "dist/packages", directory)
  const tarballs = readdirSync(packageDirectory).filter(
    (file) => file.startsWith(`${packagePrefix}-`) && file.endsWith(".tgz"),
  )
  const tarball = tarballs.at(0)
  if (tarballs.length !== 1 || tarball === undefined) {
    throw new Error(
      `Expected one ${packagePrefix} tarball in ${packageDirectory}, found ${tarballs.length}`,
    )
  }
  return join(packageDirectory, tarball)
}

const tempDirs: string[] = []

const cleanupDir = (dir: string) => {
  rmSync(dir, { force: true, recursive: true })
}

describe("pfcli init slow smoke", () => {
  afterEach(() => {
    for (const dir of tempDirs) cleanupDir(dir)
    tempDirs.length = 0
  })

  it("imports the org during init so the db and frontend JWT exist", () => {
    const parentDir = mkdtempSync(join(tmpdir(), "test-pfcli-init-"))
    tempDirs.push(parentDir)

    const orgPath = join(parentDir, "my-org")
    const dbPath = join(orgPath, "db", "pf.db")
    const orgFilePath = join(orgPath, "src", "org.ts")
    const customCedarPath = join(orgPath, "cedar", "custom.cedar")
    const packageJsonPath = join(orgPath, "package.json")
    const adminEmail = "admin@example.com"
    const packedRuntime = findPackedTarball(
      "processfocus-runtime",
      "processfocus-runtime",
    )
    const packedSdk = findPackedTarball("processfocus", "processfocus")

    const result = spawnSync(
      "bun",
      [
        PFCLI,
        "init",
        orgPath,
        "--identity-provider",
        "google",
        "--identity-provider",
        "github",
        "--email",
        adminEmail,
      ],
      {
        cwd: WORKSPACE_ROOT,
        env: {
          ...process.env,
          PFCLI_INIT_RUNTIME_OVERRIDE: `file:${packedRuntime}`,
          PFCLI_INIT_SDK_OVERRIDE: `file:${packedSdk}`,
          SQLITE_DATABASE_PATH: "",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    )

    if (result.status !== 0) {
      console.error("stdout:", result.stdout)
      console.error("stderr:", result.stderr)
    }

    expect(result.status).toBe(0)
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(packageJsonPath)).toBe(true)
    expect(existsSync(orgFilePath)).toBe(true)
    expect(existsSync(customCedarPath)).toBe(true)

    const packageJson: unknown = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    )
    expect(packageJson).toMatchObject({
      dependencies: {
        "@cedar-policy/cedar-wasm": "^4.12.0",
        "@tursodatabase/database": "0.7.2",
        "@tursodatabase/serverless": "1.4.0",
        "@tursodatabase/sync": "0.7.2",
        processfocus: CLI_ORGANISATION_SDK_VERSION,
      },
    })

    const output = result.stdout + result.stderr
    expect(output).toContain("System migrations completed")
    expect(output).toContain("Database import completed")
    expect(output).toContain("Frontend JWT stored in database")

    const orgFile = readFileSync(orgFilePath, "utf8")
    expect(orgFile).toContain('email: "admin@example.com"')
    expect(orgFile).toContain("google: {")
    expect(orgFile).toContain("github: {")
    expect(orgFile).not.toContain("passkey:")

    const customCedar = readFileSync(customCedarPath, "utf8")
    expect(customCedar).toContain(
      'principal == PF::ProviderUser::"admin@example.com"',
    )
    expect(customCedar).toContain(
      'action == PF::Action::"administerOAuthProviders"',
    )
    expect(customCedar).not.toContain('principal in PF::Role::"/Employee"')

    const db = new Database(dbPath, { readonly: true })
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations_pf'",
      )
      .all()
    db.close()

    expect(tables).toHaveLength(1)

    const jwtResult = spawnSync("bun", [PFCLI, "get-frontend-jwt", orgPath], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        SQLITE_DATABASE_PATH: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    })

    expect(jwtResult.status).toBe(0)
    expect(jwtResult.stdout.trim().split(".")).toHaveLength(3)
  }, 60_000)
})
