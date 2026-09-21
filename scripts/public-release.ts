import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  RELEASE_PACKAGES,
  RELEASE_TAG,
  RELEASE_VERSION,
  assertReleaseManifest,
  parseManifest,
  record,
  releaseConfiguration,
} from "../tools/public-release/policy"

const run = (args: string[], cwd = process.cwd()): string => {
  const [command, ...rest] = args
  if (!command) throw new Error("Missing command")
  return execFileSync(command, rest, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      NX_NO_CLOUD: "true",
      NX_DAEMON: "false",
      NX_QUIET_INHERIT: "1",
    },
  })
}
const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex")

/** Receipt includes every byte and executable bit from the inspected tarball. */
export const inventory = (
  directory: string,
  relative = "",
): { path: string; sha256: string; mode: number; bytes: number }[] =>
  readdirSync(join(directory, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) return inventory(directory, path)
      if (!entry.isFile()) throw new Error(`Non-regular release file: ${path}`)
      const bytes = readFileSync(join(directory, path))
      return [
        {
          path,
          sha256: sha256(bytes),
          mode: statSync(join(directory, path)).mode & 0o777,
          bytes: bytes.length,
        },
      ]
    })

export const assertExecutableBins = ({
  bin,
  files,
  packageName,
}: {
  bin: unknown
  files: ReturnType<typeof inventory>
  packageName: string
}): void => {
  if (bin === undefined) return
  if (typeof bin !== "string" && !record(bin))
    throw new Error(`Invalid bin declaration: ${packageName}`)
  const targets = typeof bin === "string" ? [bin] : Object.values(bin)
  for (const target of targets) {
    if (
      typeof target !== "string" ||
      !files.some(
        (file) =>
          file.path === target.replace(/^\.\//, "") &&
          (file.mode & 0o111) !== 0,
      )
    )
      throw new Error(`Missing executable bin: ${packageName}`)
  }
}

export const prepareRelease = (output: string): void => {
  if (!existsSync("public-source.json"))
    throw new Error("Release preparation requires an exported public workspace")
  if (run(["git", "status", "--porcelain"]).trim())
    throw new Error("Release preparation requires a clean source checkout")
  const nx = parseManifest(readFileSync("nx.json", "utf8"))
  if (JSON.stringify(nx["release"]) !== JSON.stringify(releaseConfiguration))
    throw new Error("Nx Release must contain exactly the fixed initial group")
  if (existsSync(output)) throw new Error(`Release output exists: ${output}`)
  mkdirSync(output, { recursive: true })
  // No release/changelog/publish umbrella command: version planning has no writes.
  const plan = run([
    "bun",
    "scripts/nx-quiet.ts",
    "release",
    "version",
    RELEASE_VERSION,
    "--dry-run",
    "--first-release",
    "--git-commit=false",
    "--git-tag=false",
  ])
  writeFileSync(join(output, "nx-version-plan.txt"), plan)
  console.info(
    "Nx release plan validated; building and packing the fixed group",
  )
  console.info(
    run([
      "bun",
      "scripts/nx-quiet.ts",
      "run-many",
      "-t",
      "pack-check",
      `--projects=${RELEASE_PACKAGES.join(",")}`,
      "--parallel=2",
    ]),
  )
  const packages = RELEASE_PACKAGES.map((name) => {
    // Bun's tarball filename drops the scope's @ and replaces / with -.
    const prefix = name.replace("@", "").replace("/", "-")
    const tarball = `${prefix}-${RELEASE_VERSION}.tgz`
    const source = resolve("dist/packages", prefix, tarball)
    // verify-distribution.ts preserves @ in the inspection directory name.
    const unpacked = resolve(
      "dist/package-inspection",
      name.replace("/", "-"),
      "package",
    )
    const manifest = parseManifest(
      readFileSync(join(unpacked, "package.json"), "utf8"),
    )
    assertReleaseManifest(manifest, name)
    if (
      !readFileSync(join(unpacked, "LICENSE.md")).equals(
        readFileSync("LICENSE.md"),
      )
    )
      throw new Error(`License differs from reviewed source: ${name}`)
    const files = inventory(unpacked)
    assertExecutableBins({ bin: manifest["bin"], files, packageName: name })
    cpSync(source, join(output, tarball))
    cpSync(join(unpacked, "LICENSE.md"), join(output, `${prefix}.LICENSE.md`))
    return {
      name,
      tarball,
      sha256: sha256(readFileSync(source)),
      manifest,
      files,
    }
  })
  const consumer = mkdtempSync(join(tmpdir(), "pf-release-consumer-"))
  const dependencies = Object.fromEntries(
    packages.map(({ name, tarball }) => [name, join(output, tarball)]),
  )
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
        overrides: dependencies,
      },
      null,
      2,
    ),
  )
  console.info("Installing all ten tarballs outside the workspace")
  writeFileSync(
    join(output, "consumer-install.txt"),
    run(["bun", "install", "--ignore-scripts"], consumer),
  )
  writeFileSync(
    join(output, "dependency-closure.txt"),
    run(["bun", "pm", "ls", "--all"], consumer),
  )
  cpSync(join(consumer, "bun.lock"), join(output, "consumer.bun.lock"))
  writeFileSync(
    join(output, "consumer-smoke.txt"),
    run(
      [
        "bun",
        "-e",
        'await import("processfocus"); await import("@processfocus/runtime"); await import("@processfocus/hosting-contract");',
      ],
      consumer,
    ),
  )
  writeFileSync(
    join(output, "pfcli-help.txt"),
    run([join(consumer, "node_modules/.bin/pfcli"), "--help"], consumer),
  )
  console.info("Exercising standalone authoring and plugin consumers")
  writeFileSync(
    join(output, "external-fixtures.txt"),
    run([
      "bun",
      "scripts/nx-quiet.ts",
      "run-many",
      "-t",
      "external-fixture",
      `--projects=${RELEASE_PACKAGES.join(",")}`,
      "--parallel=2",
    ]),
  )
  console.info(
    "Exercising the packed local runtime and consumer-built Dashboard",
  )
  writeFileSync(
    join(output, "local-dashboard.txt"),
    run(["bun", "scripts/verify-local-dashboard.ts"]),
  )
  const receipt = {
    schemaVersion: 1,
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    sourceCommit: run(["git", "rev-parse", "HEAD"]).trim(),
    publicationApproved: false,
    packages,
  }
  if (run(["git", "status", "--porcelain"]).trim())
    throw new Error("Release verification changed the source checkout")
  writeFileSync(
    join(output, "release.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
  writeFileSync(
    join(output, "SHA256SUMS"),
    inventory(output)
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(""),
  )
  console.info(`Review artifacts: ${output}`)
}

if (import.meta.main) {
  const [output, ...extra] = process.argv.slice(2)
  if (!output || extra.length)
    throw new Error(
      "Usage: bun scripts/public-release.ts <new-output-directory>",
    )
  prepareRelease(resolve(output))
}
