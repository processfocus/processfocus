import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ORGANISATION_FRONTEND_MANIFEST_VERSION } from "@pf/frontend-manifest"

const emptyProcesses = { documentation: [] }
const postHogModule = "@processfocus/plugin-posthog/register-client"
const googleDrivePlugin = {
  module: "@processfocus/plugin-google-drive/register-client",
  type: "google-drive",
}

describe("frontend manifest store", () => {
  const originalCwd = process.cwd()
  const originalNodeEnv = process.env["NODE_ENV"]
  const originalPfOrg = process.env["PF_ORG"]
  const originalWorkspaceRoot = process.env["NX_WORKSPACE_ROOT"]
  let tempDir: string | undefined

  afterEach(async () => {
    const { clearFrontendManifestCache } = await import(
      "../lib/frontend-manifest-store"
    )

    clearFrontendManifestCache()
    process.chdir(originalCwd)

    if (originalPfOrg === undefined) {
      delete process.env["PF_ORG"]
    } else {
      process.env["PF_ORG"] = originalPfOrg
    }

    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"]
    } else {
      process.env["NODE_ENV"] = originalNodeEnv
    }

    if (originalWorkspaceRoot === undefined) {
      delete process.env["NX_WORKSPACE_ROOT"]
    } else {
      process.env["NX_WORKSPACE_ROOT"] = originalWorkspaceRoot
    }

    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true })
      tempDir = undefined
    }

    vi.restoreAllMocks()
  })

  test("defaults to a disabled manifest when PF_ORG is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    process.chdir(tempDir)
    delete process.env["PF_ORG"]
    delete process.env["NX_WORKSPACE_ROOT"]

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [],
      },
    })
  })

  test("falls back to a generated frontend manifest in production when PF_ORG is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "lib/generated"), { recursive: true })
    process.chdir(tempDir)
    delete process.env["PF_ORG"]
    delete process.env["NX_WORKSPACE_ROOT"]
    process.env["NODE_ENV"] = "production"

    writeFileSync(
      join(tempDir, "lib/generated/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [
            {
              module: postHogModule,
              type: "analytics.posthog",
              config: {
                apiKey: "phc_test_123",
                host: "https://us.i.posthog.com",
              },
            },
          ],
          formComponents: [googleDrivePlugin],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [
          {
            module: postHogModule,
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [googleDrivePlugin],
      },
    })
  })

  test("reads PF_ORG relative to NX_WORKSPACE_ROOT", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "apps/frontend"), { recursive: true })
    mkdirSync(join(tempDir, "orgs/test-org/dist"), { recursive: true })
    process.chdir(join(tempDir, "apps/frontend"))
    process.env["NX_WORKSPACE_ROOT"] = tempDir
    process.env["PF_ORG"] = "orgs/test-org"

    writeFileSync(
      join(tempDir, "orgs/test-org/dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [
            {
              stepPath: "/school/enrolment/Submit enquiry",
              processName: "Enrolment Enquiry",
              processPath: "/school/enrolment",
              mutationName: "startEnrolment",
              inputTypeName: "SchoolEnrolmentSubmitEnquiry",
              totalFields: 2,
              formDefinition: null,
              defaultValues: null,
              jsonSchema: null,
              sites: ["https://school.example.com"],
              thankYou: "Thanks",
            },
          ],
        },
        plugins: {
          analytics: [
            {
              module: postHogModule,
              type: "analytics.posthog",
              config: {
                apiKey: "phc_test_123",
                host: "https://us.i.posthog.com",
              },
            },
          ],
          formComponents: [googleDrivePlugin],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [
          {
            stepPath: "/school/enrolment/Submit enquiry",
            processName: "Enrolment Enquiry",
            processPath: "/school/enrolment",
            mutationName: "startEnrolment",
            inputTypeName: "SchoolEnrolmentSubmitEnquiry",
            totalFields: 2,
            formDefinition: null,
            defaultValues: null,
            jsonSchema: null,
            sites: ["https://school.example.com"],
            thankYou: "Thanks",
          },
        ],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [
          {
            module: postHogModule,
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [googleDrivePlugin],
      },
    })
  })

  test("logs frontend plugin types when loading the manifest", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const manifestPath = join(tempDir, "org/dist/frontend-manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [
            {
              module: postHogModule,
              type: "analytics.posthog",
              config: {
                apiKey: "phc_test_123",
                host: "https://us.i.posthog.com",
              },
            },
          ],
          formComponents: [googleDrivePlugin],
        },
      }),
      "utf8",
    )
    const info = vi.spyOn(console, "info").mockImplementation(() => {})

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    getFrontendManifest()

    expect(info).toHaveBeenCalledWith(
      `[frontend-manifest] loaded 2 frontend plugin(s): analytics.posthog, google-drive from ${manifestPath}`,
    )
  })

  test("reads an absolute PF_ORG path directly", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    writeFileSync(
      join(tempDir, "org/dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [],
          formComponents: [googleDrivePlugin],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [googleDrivePlugin],
      },
    })
  })

  test("resolves frontend manifest public asset paths safely", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const { resolveFrontendManifestPublicFilePath } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(
      resolveFrontendManifestPublicFilePath("/_pf/app-icons/favicon.png"),
    ).toBe(join(tempDir, "org/dist/_pf/app-icons/favicon.png"))
    expect(
      resolveFrontendManifestPublicFilePath(
        "/_pf/public-form-branding/logo.svg",
      ),
    ).toBe(join(tempDir, "org/dist/_pf/public-form-branding/logo.svg"))
    expect(
      resolveFrontendManifestPublicFilePath("/favicon.png"),
    ).toBeUndefined()
    expect(
      resolveFrontendManifestPublicFilePath("/_pf/app-icons/"),
    ).toBeUndefined()
    expect(
      resolveFrontendManifestPublicFilePath("/_pf/app-icons//favicon.png"),
    ).toBeUndefined()
    expect(
      resolveFrontendManifestPublicFilePath(
        "/_pf/app-icons/../../frontend-manifest.json",
      ),
    ).toBeUndefined()
    expect(
      resolveFrontendManifestPublicFilePath("/_pf/app-icons/..\\secret"),
    ).toBeUndefined()
  })

  test("resolves frontend manifest docs directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const { resolveFrontendManifestDocsDirectoryPath } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(resolveFrontendManifestDocsDirectoryPath()).toBe(
      join(tempDir, "org/dist/docs"),
    )

    delete process.env["PF_ORG"]
    process.env["NODE_ENV"] = "production"
    process.chdir(tempDir)

    expect(resolveFrontendManifestDocsDirectoryPath()).toBe(
      join(tempDir, "lib/generated/docs"),
    )
  })

  test("uses the explicit PF_ORG manifest and docs in production", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    const orgPath = join(tempDir, "org")
    mkdirSync(join(orgPath, "dist/docs/enrolment-enquiry"), {
      recursive: true,
    })
    process.chdir(tempDir)
    process.env["NODE_ENV"] = "production"
    process.env["PF_ORG"] = orgPath
    delete process.env["NX_WORKSPACE_ROOT"]

    writeFileSync(
      join(orgPath, "dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        processes: {
          documentation: [
            {
              processPath: "/enrolment-enquiry",
              documentationPath: "docs/enrolment-enquiry/setup.md",
            },
          ],
        },
        plugins: {
          analytics: [],
          formComponents: [],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest, resolveFrontendManifestDocsDirectoryPath } =
      await import("../lib/frontend-manifest-store")

    expect(getFrontendManifest().processes.documentation).toEqual([
      {
        processPath: "/enrolment-enquiry",
        documentationPath: "docs/enrolment-enquiry/setup.md",
      },
    ])
    expect(resolveFrontendManifestDocsDirectoryPath()).toBe(
      join(orgPath, "dist/docs"),
    )
  })

  test("falls back to resolving PF_ORG relative to process.cwd()", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "apps/frontend"), { recursive: true })
    mkdirSync(join(tempDir, "orgs/test-org/dist"), { recursive: true })
    process.chdir(join(tempDir, "apps/frontend"))
    process.env["PF_ORG"] = "orgs/test-org"
    delete process.env["NX_WORKSPACE_ROOT"]

    writeFileSync(
      join(tempDir, "orgs/test-org/dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [],
          formComponents: [],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [],
      },
    })
  })

  test("reuses the cached manifest on subsequent reads", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const manifestPath = join(tempDir, "org/dist/frontend-manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [],
          formComponents: [googleDrivePlugin],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [googleDrivePlugin],
      },
    })

    writeFileSync(manifestPath, "{not json}", "utf8")

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [googleDrivePlugin],
      },
    })
  })

  test("propagates malformed JSON errors from the frontend manifest", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    writeFileSync(
      join(tempDir, "org/dist/frontend-manifest.json"),
      "{not json}",
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(() => getFrontendManifest()).toThrow()
  })

  test("rejects frontend plugin entries without module metadata", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    writeFileSync(
      join(tempDir, "org/dist/frontend-manifest.json"),
      JSON.stringify({
        version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
        embed: { entries: [] },
        plugins: {
          analytics: [{ type: "analytics.posthog", config: {} }],
          formComponents: [],
        },
      }),
      "utf8",
    )

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(() => getFrontendManifest()).toThrow(
      "plugins.analytics[0].module must be a string",
    )
  })

  test("propagates non-ENOENT read errors from the frontend manifest", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist/frontend-manifest.json"), {
      recursive: true,
    })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const { getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(() => getFrontendManifest()).toThrow()
  })

  test("fails closed when the frontend manifest uses an older or missing version", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "frontend-manifest-"))
    mkdirSync(join(tempDir, "org/dist"), { recursive: true })
    process.chdir(tempDir)
    process.env["PF_ORG"] = join(tempDir, "org")
    delete process.env["NX_WORKSPACE_ROOT"]

    const manifestPath = join(tempDir, "org/dist/frontend-manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 0,
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [],
          formComponents: [],
        },
      }),
      "utf8",
    )

    const { clearFrontendManifestCache, getFrontendManifest } = await import(
      "../lib/frontend-manifest-store"
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [],
      },
    })

    clearFrontendManifestCache()
    writeFileSync(
      manifestPath,
      JSON.stringify({
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [],
          formComponents: [],
        },
      }),
      "utf8",
    )

    expect(getFrontendManifest()).toEqual({
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: "Process Focus",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [],
      },
      processes: emptyProcesses,
      plugins: {
        analytics: [],
        formComponents: [],
      },
    })
  })
})
