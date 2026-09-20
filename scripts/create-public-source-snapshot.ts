import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { workspaceRoot } from "@nx/devkit"
import {
  PRIVATE_SOURCE_PROJECT_ROOTS,
  PUBLIC_SNAPSHOT_INPUTS,
} from "../tools/project-boundaries/policy"
import { preparePublicSourceWorkspace } from "./prepare-public-source-workspace"

// These exclusions are export policy, not changes to the private source tree.
export const SNAPSHOT_EXCLUSIONS = [
  "apps/www/cdk",
  "apps/www/cdk.json",
  "apps/www/cdk.context.json",
  // These suites exercise private organisation/runtime implementations. Public
  // CLI unit suites and demo build verification remain in the exported workspace.
  "cli/pfcli/test/build.spec.ts",
  "cli/pfcli/test/distribution-build.spec.ts",
  "cli/pfcli/test/aws-artifact-runtime.ts",
  "runtime/local/src/job-worker/startup-check.spec.ts",
  "runtime/local/src/graphql-api/delegation-roundtrip.db.spec.ts",
  "packages/auth-local-cedar/test/delegation.spec.ts",
  "packages/sqlite-operations/test/delegation-management.test.ts",
  "apps/graphql-e2e/steps/cloud-org.steps.ts",
  "apps/frontend-e2e/src/steps/school-enquiry.steps.ts",
  "apps/frontend-e2e/src/steps/school-terms.steps.ts",
] as const

const excludedPath = (path: string): boolean =>
  SNAPSHOT_EXCLUSIONS.some((root) => within(path, root)) ||
  /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path)

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`)

export const validatePublicSnapshotInputs = (
  inputs: readonly string[] = PUBLIC_SNAPSHOT_INPUTS,
): string[] =>
  inputs.flatMap((input) => {
    if (
      !input ||
      input.startsWith("/") ||
      input.includes("\\") ||
      /[*?![\]:]/.test(input) ||
      [...input].some((character) => character.charCodeAt(0) < 32) ||
      input.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
    ) {
      return [
        `Public snapshot input is not an explicit positive path: ${input}`,
      ]
    }
    const privateRoot = PRIVATE_SOURCE_PROJECT_ROOTS.find(
      (root) => within(root, input) || within(input, root),
    )
    return privateRoot
      ? [
          `Public snapshot input ${input} overlaps private project ${privateRoot}`,
        ]
      : []
  })

export const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex")

export const snapshotGit = (
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Buffer => {
  const result = spawnSync("git", args, {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env, GIT_NO_REPLACE_OBJECTS: "1" },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Git failed: ${result.stderr.toString()}`)
  }
  return result.stdout
}

/** Freeze a local verification tree without committing or modifying the real index. */
export const capturePublicWorktree = (): string => {
  const temporary = mkdtempSync(join(tmpdir(), "pf-snapshot-index-"))
  const env = { GIT_INDEX_FILE: join(temporary, "index") }
  try {
    snapshotGit(workspaceRoot, ["read-tree", "HEAD"], env)
    snapshotGit(
      workspaceRoot,
      ["add", "-A", "--", ...PUBLIC_SNAPSHOT_INPUTS],
      env,
    )
    return snapshotGit(workspaceRoot, ["write-tree"], env).toString().trim()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export type SnapshotReceipt = {
  schemaVersion: 1
  sourceRevision: string
  sourceTree: string
  inputs: readonly string[]
  exclusions: readonly string[]
  excluded: string[]
  snapshotSha256: string
  transformations: {
    path: string
    reason:
      | "package-license-metadata"
      | "canonical-license-copy"
      | "public-workspace-configuration"
    sourceSha256: string | null
  }[]
  files: { path: string; mode: string; sha256: string; bytes: number }[]
}

export const createPublicSourceSnapshot = (
  destination: string,
  {
    sourceRoot = workspaceRoot,
    revision = "HEAD",
    sourceTree,
    inputs = PUBLIC_SNAPSHOT_INPUTS,
  }: {
    sourceRoot?: string
    revision?: string
    sourceTree?: string
    inputs?: readonly string[]
  } = {},
): SnapshotReceipt => {
  const errors = validatePublicSnapshotInputs(inputs)
  if (errors.length > 0) throw new Error(errors.join("\n"))
  const sourceRevision = snapshotGit(sourceRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ])
    .toString()
    .trim()
  const tree = snapshotGit(sourceRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${sourceTree ?? sourceRevision}^{tree}`,
  ])
    .toString()
    .trim()
  const absoluteDestination = resolve(destination)
  const auditPath = `${absoluteDestination}.audit.json`
  if (existsSync(absoluteDestination) || existsSync(auditPath)) {
    throw new Error(
      `Snapshot destination or audit already exists: ${absoluteDestination}`,
    )
  }

  const entries = snapshotGit(sourceRoot, [
    "ls-tree",
    "-rz",
    "--full-tree",
    tree,
    "--",
    ...inputs,
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/s.exec(entry)
      if (!match) throw new Error("Invalid Git tree entry")
      const [, mode, type, object, path] = match
      if (
        !mode ||
        !object ||
        !path ||
        type !== "blob" ||
        (!["100644", "100755"].includes(mode) && !excludedPath(path))
      ) {
        throw new Error(
          "Snapshots require regular files; symlinks and submodules are prohibited",
        )
      }
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
      ) {
        throw new Error(`Unsafe snapshot path: ${path}`)
      }
      return { mode, object, path }
    })
  for (const input of inputs) {
    if (!entries.some(({ path }) => within(path, input))) {
      throw new Error(
        `Public snapshot input does not exist at ${sourceRevision}: ${input}`,
      )
    }
  }
  const excluded: string[] = []
  const files: SnapshotReceipt["files"] = []
  const transformations: SnapshotReceipt["transformations"] = []
  const licenseEntry = entries.find(({ path }) => path === "LICENSE.md")
  if (!licenseEntry) throw new Error("Snapshot inputs must include LICENSE.md")
  const license = snapshotGit(sourceRoot, [
    "cat-file",
    "blob",
    licenseEntry.object,
  ])
  const packageRoots: string[] = []
  const writeSnapshotFile = (
    path: string,
    mode: string,
    content: Buffer,
  ): void => {
    const output = join(absoluteDestination, path)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, content, {
      flag: "wx",
      mode: mode === "100755" ? 0o755 : 0o644,
    })
    files.push({ path, mode, sha256: sha256(content), bytes: content.length })
  }
  mkdirSync(absoluteDestination, { recursive: true })
  for (const { path, mode, object } of entries) {
    if (excludedPath(path)) {
      excluded.push(path)
      continue
    }
    let content = snapshotGit(sourceRoot, ["cat-file", "blob", object])
    if (path === "package.json" || path.endsWith("/package.json")) {
      const manifest: unknown = JSON.parse(content.toString())
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        Array.isArray(manifest)
      ) {
        throw new Error(`Invalid package manifest: ${path}`)
      }
      if (
        "license" in manifest &&
        manifest.license !== "SEE LICENSE IN LICENSE.md"
      ) {
        throw new Error(
          `Review existing package license before normalizing: ${path}`,
        )
      }
      packageRoots.push(dirname(path))
      if (!("license" in manifest)) {
        transformations.push({
          path,
          reason: "package-license-metadata",
          sourceSha256: sha256(content),
        })
        content = Buffer.from(
          `${JSON.stringify({ ...manifest, license: "SEE LICENSE IN LICENSE.md" }, null, 2)}\n`,
        )
      }
    }
    if (path.endsWith("/LICENSE.md") && !content.equals(license)) {
      const normalized = (text: Buffer): string =>
        text.toString().replaceAll("(c)", "©").replace(/\s+/g, " ").trim()
      if (normalized(content) !== normalized(license)) {
        throw new Error(
          `Review differing license terms before normalizing: ${path}`,
        )
      }
      transformations.push({
        path,
        reason: "canonical-license-copy",
        sourceSha256: sha256(content),
      })
      content = license
    }
    writeSnapshotFile(path, mode, content)
  }
  for (const root of packageRoots) {
    const path = root === "." ? "LICENSE.md" : `${root}/LICENSE.md`
    if (!files.some((file) => file.path === path)) {
      transformations.push({
        path,
        reason: "canonical-license-copy",
        sourceSha256: null,
      })
      writeSnapshotFile(path, "100644", license)
    }
  }
  if (existsSync(join(absoluteDestination, "nx.json"))) {
    for (const edit of preparePublicSourceWorkspace(absoluteDestination)) {
      transformations.push({
        path: edit.path,
        reason: "public-workspace-configuration",
        sourceSha256: edit.before ? sha256(edit.before) : null,
      })
      const previous = files.find((file) => file.path === edit.path)
      if (previous) {
        previous.sha256 = sha256(edit.after)
        previous.bytes = edit.after.length
      } else
        files.push({
          path: edit.path,
          mode: "100644",
          sha256: sha256(edit.after),
          bytes: edit.after.length,
        })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"))
  const receipt: SnapshotReceipt = {
    schemaVersion: 1,
    sourceRevision,
    sourceTree: tree,
    inputs,
    exclusions: SNAPSHOT_EXCLUSIONS,
    excluded,
    snapshotSha256: sha256(JSON.stringify(files)),
    transformations,
    files,
  }
  writeFileSync(auditPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  })
  return receipt
}

if (import.meta.main) {
  const [argument, revision, ...extraArguments] = process.argv.slice(2)
  if (!argument || extraArguments.length > 0) {
    throw new Error(
      "Usage: bun scripts/create-public-source-snapshot.ts <destination> [revision | --worktree] | --check",
    )
  }
  const errors = validatePublicSnapshotInputs()
  if (errors.length > 0) throw new Error(errors.join("\n"))
  if (argument === "--check") {
    console.info(
      `Public snapshot allowlist is valid (${PUBLIC_SNAPSHOT_INPUTS.length} inputs).`,
    )
  } else {
    const receipt = createPublicSourceSnapshot(
      argument,
      revision === "--worktree"
        ? { sourceTree: capturePublicWorktree() }
        : revision
          ? { revision }
          : {},
    )
    console.info(
      `Created unapproved candidate at ${resolve(argument)} (${receipt.snapshotSha256}). Private audit: ${resolve(argument)}.audit.json`,
    )
  }
}
