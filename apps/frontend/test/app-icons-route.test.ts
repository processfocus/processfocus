import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ORGANISATION_FRONTEND_MANIFEST_VERSION } from "@pf/frontend-manifest"

describe("app icons route", () => {
  const originalPfOrg = process.env["PF_ORG"]
  let tempDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "app-icons-route-"))
    const orgDir = join(tempDir, "org")
    mkdirSync(join(orgDir, "dist/_pf/app-icons"), { recursive: true })
    process.env["PF_ORG"] = orgDir

    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        appIcons: {
          metadata: [
            {
              url: "/_pf/app-icons/favicon-1234567890abcdef.png",
              rel: "icon",
              type: "image/png",
            },
            {
              url: "/_pf/app-icons/custom.png",
              rel: "icon",
              type: "image/png",
            },
            {
              url: "/_pf/app-icons/missing.png",
              rel: "icon",
              type: "image/png",
            },
            {
              url: "/_pf/app-icons/../../frontend-manifest.json",
              rel: "icon",
              type: "application/json",
            },
          ],
          manifest: [],
        },
        embed: { entries: [] },
        plugins: { analytics: [], formComponents: [] },
      }),
      "utf8",
    )
    writeFileSync(
      join(orgDir, "dist/_pf/app-icons/favicon-1234567890abcdef.png"),
      "hashed icon",
    )
    writeFileSync(join(orgDir, "dist/_pf/app-icons/custom.png"), "custom icon")
  })

  afterEach(async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()

    if (originalPfOrg === undefined) {
      delete process.env["PF_ORG"]
    } else {
      process.env["PF_ORG"] = originalPfOrg
    }

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  test("serves manifest-listed icon files with content type and cache headers", async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()
    const { GET } = await import("../app/%5Fpf/app-icons/[...path]/route")

    const hashed = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["favicon-1234567890abcdef.png"] }),
    })
    const explicit = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["custom.png"] }),
    })

    expect(hashed.status).toBe(200)
    expect(hashed.headers.get("Content-Type")).toBe("image/png")
    expect(hashed.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    )
    await expect(hashed.text()).resolves.toBe("hashed icon")

    expect(explicit.status).toBe(200)
    expect(explicit.headers.get("Content-Type")).toBe("image/png")
    expect(explicit.headers.get("Cache-Control")).toBe("public, max-age=3600")
  })

  test("returns 404 for unknown, missing, and traversal icon paths", async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()
    const { GET } = await import("../app/%5Fpf/app-icons/[...path]/route")

    const unknown = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["unknown.png"] }),
    })
    const missing = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["missing.png"] }),
    })
    const traversal = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["..", "..", "frontend-manifest.json"] }),
    })

    expect(unknown.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(traversal.status).toBe(404)
  })
})
