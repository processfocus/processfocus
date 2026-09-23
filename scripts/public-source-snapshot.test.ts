import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PRIVATE_SOURCE_PROJECT_ROOTS } from "../tools/project-boundaries/policy"
import {
  capturePublicWorktree,
  createPublicSourceSnapshot,
} from "./create-public-source-snapshot"
import { expect, test } from "bun:test"

test("public export excludes private projects and has self-contained workspace references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-public-snapshot-"))
  const destination = join(root, "snapshot")
  try {
    const receipt = createPublicSourceSnapshot(destination, {
      sourceTree: capturePublicWorktree(),
    })
    const paths = receipt.files.map(({ path }) => path)
    for (const privateRoot of PRIVATE_SOURCE_PROJECT_ROOTS) {
      expect(
        paths.filter((path) => path.startsWith(`${privateRoot}/`)),
      ).toEqual([])
    }
    expect(
      paths.filter((path) => path.startsWith(".github/workflows/")),
    ).toEqual([
      ".github/workflows/public-release.yml",
      ".github/workflows/public-source.yml",
    ])
    expect(paths).not.toContain(
      "packages/auth-local-cedar/test/delegation.spec.ts",
    )
    expect(paths).not.toContain(
      "packages/sqlite-operations/test/delegation-management.test.ts",
    )
    const manifest = await Bun.file(join(destination, "package.json")).json()
    expect(manifest.workspaces).toContain("examples/demo")
    expect(manifest.workspaces).not.toContain("examples/school")
    expect(manifest.scripts.prepare).toBeUndefined()
    const sqliteOperations = await Bun.file(
      join(destination, "packages/sqlite-operations/package.json"),
    ).json()
    expect(
      sqliteOperations.devDependencies["@pf/layer-sqlite-bun"],
    ).toBeUndefined()
    const sqliteReferences = await Bun.file(
      join(destination, "packages/sqlite-operations/tsconfig.lib.json"),
    ).json()
    expect(sqliteReferences.references).not.toContainEqual({
      path: "../layer-sqlite-bun/tsconfig.lib.json",
    })
    expect(sqliteReferences.references).toContainEqual({
      path: "../service-drizzle-sqlite/tsconfig.lib.json",
    })
    expect(
      await Bun.file(
        join(destination, "apps/graphql-e2e/steps/index.ts"),
      ).text(),
    ).not.toContain("cloud-org.steps")
    const lock = await Bun.file(join(destination, "bun.lock")).json()
    expect(Object.keys(lock.workspaces).sort()).toEqual(
      ["", ...manifest.workspaces].sort(),
    )
    const references = await Bun.file(join(destination, "tsconfig.json")).json()
    for (const { path } of references.references) {
      expect(
        await Bun.file(join(destination, path, "tsconfig.json")).exists(),
      ).toBe(true)
    }
    for (const path of [
      "scripts/build-public-dashboard.sh",
      "scripts/ci-frontend-build-lifecycle.sh",
      "scripts/ci-frontend-build-database.sh",
      "public-source.json",
    ])
      expect(paths).toContain(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
