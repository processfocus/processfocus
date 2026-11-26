import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createPreflightHarness } from "./preflight-harness"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

// Owns the packaged GraphQL boundary: source tests cannot detect incompatible
// parser identities between the independently bundled organisation and host.
test("deployment artifact completes GraphQL across independent bundles and rejects defective contracts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pf-artifact-roundtrip-"))
  const preflightHarness = createPreflightHarness()
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env["PATH"],
        HOME: directory,
        AWS_EC2_METADATA_DISABLED: "true",
        ...env,
      },
    })
  try {
    const artifact = join(directory, "dist")
    const build = run([
      join(root, "cli/pfcli/src/main.ts"),
      "build",
      join(import.meta.dir, "fixtures/artifact-roundtrip"),
      "--output",
      artifact,
    ])
    expect(build.status, build.stderr + build.stdout).toBe(0)
    const host = join(directory, "host.mjs")
    const hostBuild = run([
      "build",
      join(root, "runtime/local/src/graphql-api/artifact-roundtrip.host.ts"),
      "--target=bun",
      "--minify",
      `--outfile=${host}`,
      "--external=@cedar-policy/cedar-wasm",
    ])
    expect(hostBuild.status, hostBuild.stderr).toBe(0)
    mkdirSync(join(directory, "node_modules/@cedar-policy"), {
      recursive: true,
    })
    cpSync(
      join(root, "cli/pfcli/node_modules/@cedar-policy/cedar-wasm"),
      join(directory, "node_modules/@cedar-policy/cedar-wasm"),
      { recursive: true, dereference: true },
    )
    cpSync(
      join(root, "packages/drizzle-sqlite/drizzle"),
      join(directory, "migrations"),
      { recursive: true },
    )
    const execute = () =>
      run(["--no-install", host, artifact], {
        MIGRATIONS_FOLDER: join(directory, "migrations"),
      })
    const green = execute()
    expect(green.status, green.stderr + green.stdout).toBe(0)
    expect(green.stdout).toContain("artifact GraphQL start/completion passed")

    const bundlePath = join(artifact, "org.js")
    const bundle = readFileSync(bundlePath, "utf8")
    // Reproduce the cross-bundle regression by giving the organisation
    // parser a different sentinel key from the host.
    const brokenParser = bundle.replaceAll(
      "effect/schema/parser/missing",
      "defective/schema/parser/missing",
    )
    expect(brokenParser).not.toBe(bundle)
    writeFileSync(bundlePath, brokenParser)
    const red = execute()
    expect(red.status).not.toBe(0)
    expect(red.stderr).toContain("AssertionError")
    expect(red.stderr).toContain("startWork")
    expect(red.stderr).toContain("Expected a valid UTC DateTime string")
    writeFileSync(bundlePath, bundle)

    const preflight = (source: string, phase: string) => {
      writeFileSync(bundlePath, source)
      return spawnSync(
        process.execPath,
        [
          join(
            root,
            "cloud/org/src/docker/deploy-project/configuration-preflight.ts",
          ),
          artifact,
          "0000-0000-0002",
          "local",
          "test",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...preflightHarness.env, HOME: directory },
          input: JSON.stringify({
            phase,
            stageValues: {},
            platformValues: { PF_ENV: "local" },
          }),
        },
      )
    }
    for (const phase of ["stage", "readiness"]) {
      expect(preflight(bundle, phase).status).toBe(0)
      const missing = preflight("export const org = {};", phase)
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain("contract")
      const empty = preflight(
        "export const org = {}; export const Configuration = {version: 1, groups: []};",
        phase,
      )
      expect(empty.status, empty.stderr).toBe(0)
    }
  } finally {
    preflightHarness.cleanup()
    rmSync(directory, { recursive: true, force: true })
  }
}, 150_000)
