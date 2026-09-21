import { assertDashboardPackageFile } from "./dashboard-package-policy"
import { describe, expect, test } from "bun:test"

describe("public Dashboard package policy", () => {
  test.each([
    "dist/dashboard/apps/frontend/server.js",
    "dist/source/.next/server/app.js",
    "dist/source/.open-next/server-functions/default/index.mjs",
    "dist/source/BUILD_ID",
    "dist/source/server-reference-manifest.json",
    "dist/source/prerender-manifest.json",
    "dist/source/node_modules/next/package.json",
  ])("rejects build artifact %s", (path) => {
    expect(() => assertDashboardPackageFile(path)).toThrow("compiled Dashboard")
  })
  test.each([
    "encryptionKey",
    "previewModeId",
    "previewModeEncryptionKey",
    "previewModeSigningKey",
  ])("rejects generated %s even outside conventional output paths", (field) => {
    expect(() =>
      assertDashboardPackageFile(
        "dist/renamed.json",
        JSON.stringify({ [field]: "generated-secret" }),
      ),
    ).toThrow("secret material")
    expect(() =>
      assertDashboardPackageFile(
        "dist/renamed.js",
        `${field}: 'generated-secret'`,
      ),
    ).toThrow("secret material")
  })
  test("allows source, directives, and build-tool references to output paths", () => {
    expect(() =>
      assertDashboardPackageFile(
        "dist/dashboard-source/apps/frontend/app/page.tsx",
        '"use client"; export default function Page() { return null }',
      ),
    ).not.toThrow()
    expect(() =>
      assertDashboardPackageFile("dist/main.mjs", 'readFile(".next/BUILD_ID")'),
    ).not.toThrow()
  })
})
