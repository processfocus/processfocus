import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"
import {
  RELEASE_PACKAGES,
  RELEASE_VERSION,
  assertReleaseManifest,
  releaseConfiguration,
} from "../tools/public-release/policy"
import { hasCredential } from "./check-public-source"
import { assertExecutableBins, inventory } from "./public-release"
import { expect, test } from "bun:test"

const manifest = () => ({
  name: "processfocus",
  version: RELEASE_VERSION,
  license: "SEE LICENSE IN LICENSE.md",
  publishConfig: { access: "public", tag: "next" },
  dependencies: { "@processfocus/runtime": RELEASE_VERSION },
})

test("the initial fixed group contains exactly the ten issue packages", () => {
  expect(RELEASE_PACKAGES).toHaveLength(10)
  expect(Object.keys(releaseConfiguration.groups)).toEqual(["public"])
  expect(releaseConfiguration.groups.public.projectsRelationship).toBe("fixed")
  expect(releaseConfiguration.groups.public.projects).not.toContain(
    "@processfocus/pforg",
  )
  expect(releaseConfiguration.groups.public.projects).not.toContain(
    "@processfocus/plugin-xero",
  )
  assertReleaseManifest(manifest(), "processfocus")
})

test("packed manifests fail closed on nonmembers, tags, private packages and dependency leaks", () => {
  for (const patch of [
    { version: "0.1.0" },
    { private: true },
    { publishConfig: { access: "public", tag: "latest" } },
    { license: "MIT" },
    { dependencies: { "@pf/process": "1.0.0" } },
    { dependencies: { "@processfocus/runtime": "workspace:*" } },
    { peerDependencies: { "@processfocus/runtime": "^0.1.0" } },
    { optionalDependencies: { "@processfocus/plugin-xero": RELEASE_VERSION } },
    { dependencies: { outside: "file:../outside" } },
  ])
    expect(() =>
      assertReleaseManifest({ ...manifest(), ...patch }, "processfocus"),
    ).toThrow()
  expect(() => assertReleaseManifest(manifest(), "@pf/process")).toThrow()
})

test("receipts detect byte and executable mode changes with stable file ordering", () => {
  const directory = mkdtempSync(join(tmpdir(), "pf-receipt-test-"))
  try {
    writeFileSync(join(directory, "b"), "script")
    writeFileSync(join(directory, "a"), "license")
    const before = inventory(directory)
    expect(before.map((file) => file.path)).toEqual(["a", "b"])
    chmodSync(join(directory, "b"), 0o755)
    writeFileSync(join(directory, "a"), "changed license")
    const after = inventory(directory)
    expect(after[0]?.sha256).not.toBe(before[0]?.sha256)
    expect(after[1]?.mode).toBe(0o755)
    expect(inventory(directory)).toEqual(after)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("bin validation checks both npm manifest forms against packed executable modes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pf-bin-test-"))
  try {
    const path = join(directory, "cli.js")
    writeFileSync(path, "#!/usr/bin/env node\n", { mode: 0o644 })
    const packageName = "processfocus"
    for (const bin of ["./cli.js", { pfcli: "./cli.js" }]) {
      expect(() =>
        assertExecutableBins({ bin, files: inventory(directory), packageName }),
      ).toThrow("Missing executable bin")
    }
    chmodSync(path, 0o755)
    const files = inventory(directory)
    for (const bin of [undefined, "./cli.js", { pfcli: "./cli.js" }])
      expect(() =>
        assertExecutableBins({ bin, files, packageName }),
      ).not.toThrow()
    for (const bin of [
      "./missing.js",
      { pfcli: "./missing.js" },
      { pfcli: 42 },
    ])
      expect(() => assertExecutableBins({ bin, files, packageName })).toThrow(
        "Missing executable bin",
      )
    expect(() => assertExecutableBins({ bin: 42, files, packageName })).toThrow(
      "Invalid bin declaration",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("credential guard catches credential formats without flagging its own patterns", () => {
  for (const secret of [
    `AKIA${"A".repeat(16)}`,
    `npm_${"a".repeat(36)}`,
    `ghp_${"a".repeat(36)}`,
  ])
    expect(hasCredential(secret)).toBe(true)
  expect(
    hasCredential(readFileSync("scripts/check-public-source.ts", "utf8")),
  ).toBe(false)
})

test("PRs cannot reach OIDC and publication requires an explicit protected opt-in", () => {
  const ci = readFileSync(".github/workflows/public-source.yml", "utf8")
  const release = readFileSync(".github/workflows/public-release.yml", "utf8")
  expect(ci).not.toMatch(
    /pull_request_target|secrets\.|id-token: write|secrets: inherit/,
  )
  expect(release).toContain("environment: npm-next")
  expect(release).toContain("github.ref == 'refs/heads/trunk'")
  expect(release).not.toContain("actions/checkout")
  expect(release).not.toContain("bun install")
  expect(release).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/)
  expect(parse(release)).toMatchObject({
    on: {
      workflow_dispatch: {
        inputs: {
          mode: {
            type: "choice",
            default: "verify-oidc",
            options: ["verify-oidc", "rehearse", "publish"],
          },
        },
      },
    },
    jobs: {
      "verify-trust": {
        if: "github.repository == 'processfocus/processfocus' && github.ref == 'refs/heads/trunk' && inputs.mode == 'verify-oidc'",
        environment: "npm-next",
        permissions: { contents: "read", "id-token": "write" },
        env: {
          NPM_PACKAGES: expect.any(String),
        },
      },
      prepare: {
        if: "github.repository == 'processfocus/processfocus' && github.ref == 'refs/heads/trunk' && inputs.mode != 'verify-oidc'",
      },
      "reviewed-artifacts": {
        needs: "prepare",
        environment: "npm-next",
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: "Reject already published versions before any publication",
            if: "inputs.mode == 'publish'",
          }),
          expect.objectContaining({
            name: "Publish reviewed tarballs through npm trusted publishing",
            if: "inputs.mode == 'publish'",
          }),
        ]),
      },
    },
  })
  const packageList = release.match(/NPM_PACKAGES: >-\n((?: {8}.+\n)+)/)?.[1]
  expect(packageList).toBeDefined()
  expect(JSON.parse(packageList ?? "null")).toEqual(RELEASE_PACKAGES)
  expect(release.match(/npm publish[^\n]+/g)).toEqual([
    'npm publish "$package" --dry-run --ignore-scripts --access public --tag next',
    'npm publish "$package" --ignore-scripts --access public --tag next --provenance',
  ])
})
