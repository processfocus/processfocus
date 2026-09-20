import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ORGANISATION_FRONTEND_MANIFEST_VERSION } from "@pf/frontend-manifest"

describe("public form branding route", () => {
  const originalPfOrg = process.env["PF_ORG"]
  let tempDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "public-form-branding-route-"))
    const orgDir = join(tempDir, "org")
    mkdirSync(join(orgDir, "dist/_pf/public-form-branding"), {
      recursive: true,
    })
    process.env["PF_ORG"] = orgDir

    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        appIcons: { metadata: [], manifest: [] },
        publicFormBranding: {
          headerHtml:
            '<img src="/_pf/public-form-branding/logo-1234567890abcdef.svg">',
          footerHtml:
            '<a href="/_pf/public-form-branding/policy.pdf">Policy</a>',
        },
        embed: { entries: [] },
        plugins: { analytics: [], formComponents: [] },
      }),
      "utf8",
    )
    writeFileSync(
      join(orgDir, "dist/_pf/public-form-branding/logo-1234567890abcdef.svg"),
      "<svg />",
    )
    writeFileSync(
      join(orgDir, "dist/_pf/public-form-branding/policy.pdf"),
      "policy",
    )
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

  test("serves manifest-referenced branding files", async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()
    const { GET } = await import(
      "../app/%5Fpf/public-form-branding/[...path]/route"
    )

    const hashed = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["logo-1234567890abcdef.svg"] }),
    })
    const explicit = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["policy.pdf"] }),
    })

    expect(hashed.status).toBe(200)
    expect(hashed.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(hashed.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    )
    await expect(hashed.text()).resolves.toBe("<svg />")

    expect(explicit.status).toBe(200)
    expect(explicit.headers.get("Cache-Control")).toBe("public, max-age=3600")
  })

  test("returns 404 for unknown, missing, and traversal branding paths", async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()
    const { GET } = await import(
      "../app/%5Fpf/public-form-branding/[...path]/route"
    )

    const unknown = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["unknown.svg"] }),
    })
    const missing = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["policy-missing.pdf"] }),
    })
    const traversal = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["..", "..", "frontend-manifest.json"] }),
    })

    expect(unknown.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(traversal.status).toBe(404)
  })

  test("does not serve paths that only prefix-match branding HTML", async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir")
    }

    const orgDir = join(tempDir, "org")
    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        appIcons: { metadata: [], manifest: [] },
        publicFormBranding: {
          headerHtml:
            '<img src="/_pf/public-form-branding/logo-1234567890abcdef.svg-extra">',
        },
        embed: { entries: [] },
        plugins: { analytics: [], formComponents: [] },
      }),
      "utf8",
    )

    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )
    clearFrontendManifestCache()
    const { GET } = await import(
      "../app/%5Fpf/public-form-branding/[...path]/route"
    )

    const response = await GET(new Request("https://example.com"), {
      params: Promise.resolve({ path: ["logo-1234567890abcdef.svg"] }),
    })

    expect(response.status).toBe(404)
  })
})
