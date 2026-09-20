import { randomUUID } from "node:crypto"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Construct } from "constructs"
import { Schema as ES, Effect } from "effect"
import { FormComponentPluginType } from "@pf/form-schema"
import {
  AppIcons,
  Form,
  List,
  OrgUnit,
  Organisation,
  Process,
  PublicFormBranding,
  Role,
  buildOrganisationFrontendManifest,
  buildOrganisationFrontendManifestPublicFormBrandingFiles,
  parseOrganisationFrontendManifest,
} from "../index"
import { describe, expect, it } from "bun:test"

class FakeFrontendClientPlugin extends Construct {
  readonly isFrontendClientPluginManifestProvider = true as const
  readonly frontendManifestPluginCategory:
    | "analytics"
    | "formComponents"
    | undefined

  constructor(
    scope: Construct,
    id: string,
    private readonly plugin: unknown,
    category?: "analytics" | "formComponents",
  ) {
    super(scope, id)
    this.frontendManifestPluginCategory = category
  }

  buildFrontendClientPluginManifest(): unknown {
    return this.plugin
  }
}

const makeOrg = () => {
  const org = new Organisation({ name: "Test Org" })
  const unit = new OrgUnit(org, "school", {
    name: "School",
    type: "department",
  })
  const role = new Role(unit, "office", { name: "Office" })

  return { org, unit, role }
}

describe("organisation frontend manifest", () => {
  it("builds a unified frontend manifest with embed and categorized plugin metadata", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    new FakeFrontendClientPlugin(
      org,
      "posthog",
      {
        module: "@processfocus/plugin-posthog/register-client",
        type: "analytics.posthog",
        config: {
          apiKey: "phc_test_123",
          host: "https://us.i.posthog.com",
        },
      },
      "analytics",
    )
    new FakeFrontendClientPlugin(org, "ignored-client-plugin", {
      module: "@pf/plugins-sentry/register-client",
      type: "error-logging.sentry",
      config: {
        environment: "production",
      },
    })
    new FakeFrontendClientPlugin(
      org,
      "execution-menu",
      {
        module: "@another-scope/execution-menu/register-client",
        type: "execution-menu",
        config: {},
      },
      "formComponents",
    )

    const start = new Form(process, "Submit enquiry", {
      role,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks for your enquiry.",
      },
      form: () => ({
        email: ES.String,
        firstName: ES.String,
        attachment: ES.String.annotations({
          [FormComponentPluginType]: {
            module: "@processfocus/plugin-google-drive/register-client",
            type: "google-drive",
          },
        }),
      }),
    })

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org),
    )

    expect(manifest).toEqual({
      version: 3,
      organisation: {
        name: "Test Org",
      },
      appIcons: {
        metadata: [],
        manifest: [],
      },
      publicFormBranding: null,
      embed: {
        entries: [
          expect.objectContaining({
            stepPath: "/school/enrolment/Submit enquiry",
            sites: ["https://school.example.com"],
            thankYou: "Thanks for your enquiry.",
          }),
        ],
      },
      processes: {
        documentation: [],
      },
      plugins: {
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [
          {
            module: "@another-scope/execution-menu/register-client",
            type: "execution-menu",
          },
          {
            module: "@processfocus/plugin-google-drive/register-client",
            type: "google-drive",
          },
        ],
      },
    })
  })

  it("keeps outer wrapper annotations authoritative when collecting plugin types", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const wrappedPluginField = ES.String.pipe(ES.minLength(1))
      .annotations({
        [FormComponentPluginType]: {
          module: "inner-plugin/register-client",
          type: "inner-plugin",
        },
      })
      .pipe(ES.maxLength(5))
      .annotations({
        [FormComponentPluginType]: {
          module: "outer-plugin/register-client",
          type: "outer-plugin",
        },
      })

    const start = new Form(process, "Submit enquiry", {
      role,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks for your enquiry.",
      },
      form: () => ({
        email: ES.String,
        attachment: wrappedPluginField,
      }),
    })

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org),
    )

    expect(manifest.plugins.formComponents).toEqual([
      { module: "outer-plugin/register-client", type: "outer-plugin" },
    ])
  })

  it("collects form component plugins from list detail fields", async () => {
    const { org, unit, role } = makeOrg()

    new List(unit, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: ES.String,
        name: ES.String,
      },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: ES.String,
        attachment: ES.String.annotations({
          [FormComponentPluginType]: {
            module: "@example/list-detail-plugin/register-client",
            type: "list-detail-plugin",
          },
        }),
      }),
    })

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org),
    )

    expect(manifest.plugins.formComponents).toEqual([
      {
        module: "@example/list-detail-plugin/register-client",
        type: "list-detail-plugin",
      },
    ])
  })

  it("normalizes App Icons metadata with MIME inference and content-hashed paths", async () => {
    const orgBasePath = join(tmpdir(), `pf-app-icons-${randomUUID()}`)
    mkdirSync(orgBasePath, { recursive: true })
    writeFileSync(join(orgBasePath, "favicon.png"), "png bytes")
    writeFileSync(join(orgBasePath, "mask.svg"), "<svg />")

    const { org } = makeOrg()
    new AppIcons(org, "app-icons", {
      metadata: [{ source: "favicon.png" }],
      manifest: [
        {
          source: "mask.svg",
          sizes: "any",
          purpose: "maskable",
        },
      ],
    })

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org, { basePath: orgBasePath }),
    )

    expect(manifest.appIcons.metadata).toEqual([
      {
        url: expect.stringMatching(
          /^\/_pf\/app-icons\/favicon-[a-f0-9]{16}\.png$/,
        ),
        rel: "icon",
        type: "image/png",
        sizes: undefined,
      },
    ])
    expect(manifest.appIcons.manifest).toEqual([
      {
        src: expect.stringMatching(
          /^\/_pf\/app-icons\/mask-[a-f0-9]{16}\.svg$/,
        ),
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ])
  })

  it("allows App Icons explicit overrides under the public prefix", async () => {
    const orgBasePath = join(tmpdir(), `pf-app-icons-${randomUUID()}`)
    mkdirSync(orgBasePath, { recursive: true })
    writeFileSync(join(orgBasePath, "favicon.ico"), "ico bytes")
    writeFileSync(join(orgBasePath, "app.png"), "png bytes")

    const { org } = makeOrg()
    new AppIcons(org, "app-icons", {
      metadata: [
        {
          source: "favicon.ico",
          publicPath: "/_pf/app-icons/favicon.ico",
          rel: "shortcut icon",
          type: "image/vnd.microsoft.icon",
          sizes: "32x32",
        },
      ],
      manifest: [
        {
          source: "app.png",
          publicPath: "/_pf/app-icons/app.png",
          sizes: "192x192",
          type: "image/png",
        },
      ],
    })

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org, { basePath: orgBasePath }),
    )

    expect(manifest.appIcons).toEqual({
      metadata: [
        {
          url: "/_pf/app-icons/favicon.ico",
          rel: "shortcut icon",
          type: "image/vnd.microsoft.icon",
          sizes: "32x32",
        },
      ],
      manifest: [
        {
          src: "/_pf/app-icons/app.png",
          sizes: "192x192",
          type: "image/png",
          purpose: undefined,
        },
      ],
    })
  })

  it("builds Public Form Branding with rewritten content-hashed asset URLs", async () => {
    const orgBasePath = join(
      tmpdir(),
      `pf-public-form-branding-${randomUUID()}`,
    )
    mkdirSync(orgBasePath, { recursive: true })
    writeFileSync(join(orgBasePath, "logo.svg"), "<svg />")
    writeFileSync(join(orgBasePath, "policy.pdf"), "policy bytes")

    const { org } = makeOrg()
    new PublicFormBranding(org, "public-form-branding", {
      headerHtml:
        '<img src="logo.svg#mark"><a href="https://example.com">External</a>',
      footerHtml: "<a href='policy.pdf?download=1'>Policy</a>",
    })

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org, { basePath: orgBasePath }),
    )
    const files = buildOrganisationFrontendManifestPublicFormBrandingFiles(
      org,
      {
        basePath: orgBasePath,
      },
    )

    expect(manifest.publicFormBranding).toEqual({
      headerHtml: expect.stringMatching(
        /^<img src="\/_pf\/public-form-branding\/logo-[a-f0-9]{16}\.svg#mark"><a href="https:\/\/example\.com">External<\/a>$/,
      ),
      footerHtml: expect.stringMatching(
        /^<a href='\/_pf\/public-form-branding\/policy-[a-f0-9]{16}\.pdf\?download=1'>Policy<\/a>$/,
      ),
    })
    expect(files).toEqual([
      {
        sourcePath: join(orgBasePath, "logo.svg"),
        publicPath: expect.stringMatching(
          /^\/_pf\/public-form-branding\/logo-[a-f0-9]{16}\.svg$/,
        ),
      },
      {
        sourcePath: join(orgBasePath, "policy.pdf"),
        publicPath: expect.stringMatching(
          /^\/_pf\/public-form-branding\/policy-[a-f0-9]{16}\.pdf$/,
        ),
      },
    ])
  })

  it("allows metadata and manifest icons to reuse the same App Icons source file", async () => {
    const orgBasePath = join(tmpdir(), `pf-app-icons-${randomUUID()}`)
    mkdirSync(orgBasePath, { recursive: true })
    writeFileSync(join(orgBasePath, "favicon.png"), "png bytes")

    const { org } = makeOrg()
    new AppIcons(org, "app-icons", {
      metadata: [{ source: "favicon.png" }],
      manifest: [{ source: "favicon.png", sizes: "32x32" }],
    })

    const manifest = await Effect.runPromise(
      buildOrganisationFrontendManifest(org, { basePath: orgBasePath }),
    )

    expect(manifest.appIcons.metadata[0]?.url).toBe(
      manifest.appIcons.manifest[0]?.src,
    )
  })

  it("validates App Icons single-set and public path rules", async () => {
    expect(
      () => new AppIcons(new Organisation({ name: "Test Org" }), "empty", {}),
    ).toThrow('AppIcons "empty" must declare at least one icon')

    expect(
      () =>
        new AppIcons(new Organisation({ name: "Test Org" }), "bad-sizes", {
          manifest: [{ source: "app.png", sizes: "" }],
        }),
    ).toThrow('AppIcons "bad-sizes" manifest icons must declare sizes')

    expect(
      () =>
        new AppIcons(new Organisation({ name: "Test Org" }), "bad-purpose", {
          manifest: [{ source: "app.png", sizes: "192x192", purpose: "badge" }],
        }),
    ).toThrow(
      'AppIcons "bad-purpose" manifest icon purpose must use any, maskable, or monochrome',
    )

    const duplicateSetsOrg = new Organisation({ name: "Test Org" })
    new AppIcons(duplicateSetsOrg, "primary", {
      metadata: [{ source: "favicon.ico", publicPath: "/_pf/app-icons/a.ico" }],
    })
    new AppIcons(duplicateSetsOrg, "secondary", {
      metadata: [{ source: "other.ico", publicPath: "/_pf/app-icons/b.ico" }],
    })

    await expect(
      Effect.runPromise(buildOrganisationFrontendManifest(duplicateSetsOrg)),
    ).rejects.toThrow("Organisation must declare at most one AppIcons set")

    const invalidPublicPathOrg = new Organisation({ name: "Test Org" })
    new AppIcons(invalidPublicPathOrg, "app-icons", {
      metadata: [{ source: "favicon.ico", publicPath: "/favicon.ico" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(invalidPublicPathOrg),
      ),
    ).rejects.toThrow("AppIcons publicPath must be inside /_pf/app-icons/")

    const traversalPublicPathOrg = new Organisation({ name: "Test Org" })
    new AppIcons(traversalPublicPathOrg, "app-icons", {
      metadata: [
        {
          source: "favicon.ico",
          publicPath: "/_pf/app-icons/../../frontend-manifest.json",
        },
      ],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(traversalPublicPathOrg),
      ),
    ).rejects.toThrow("AppIcons publicPath must be inside /_pf/app-icons/")

    const duplicatePublicPathOrg = new Organisation({ name: "Test Org" })
    const duplicatePublicPathBase = join(
      tmpdir(),
      `pf-app-icons-${randomUUID()}`,
    )
    mkdirSync(duplicatePublicPathBase, { recursive: true })
    writeFileSync(join(duplicatePublicPathBase, "favicon.ico"), "ico bytes")
    writeFileSync(join(duplicatePublicPathBase, "app.png"), "png bytes")
    new AppIcons(duplicatePublicPathOrg, "app-icons", {
      metadata: [{ source: "favicon.ico", publicPath: "/_pf/app-icons/icon" }],
      manifest: [
        {
          source: "app.png",
          publicPath: "/_pf/app-icons/icon",
          sizes: "192x192",
        },
      ],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(duplicatePublicPathOrg, {
          basePath: duplicatePublicPathBase,
        }),
      ),
    ).rejects.toThrow("Duplicate AppIcons publicPath: /_pf/app-icons/icon")
  })

  it("rejects App Icons sources that are not relative org-local files", async () => {
    const orgBasePath = join(tmpdir(), `pf-app-icons-${randomUUID()}`)
    mkdirSync(join(orgBasePath, "icons"), { recursive: true })
    writeFileSync(join(orgBasePath, "icons", "favicon.png"), "png bytes")
    writeFileSync(join(orgBasePath, "outside.png"), "outside")

    const absoluteSourceOrg = new Organisation({ name: "Test Org" })
    new AppIcons(absoluteSourceOrg, "app-icons", {
      metadata: [{ source: join(orgBasePath, "icons", "favicon.png") }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(absoluteSourceOrg, {
          basePath: orgBasePath,
        }),
      ),
    ).rejects.toThrow("AppIcons source must be a relative org-local file")

    const escapingSourceOrg = new Organisation({ name: "Test Org" })
    new AppIcons(escapingSourceOrg, "app-icons", {
      metadata: [{ source: "../outside.png" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(escapingSourceOrg, {
          basePath: join(orgBasePath, "icons"),
        }),
      ),
    ).rejects.toThrow("AppIcons source must be a relative org-local file")

    const missingSourceOrg = new Organisation({ name: "Test Org" })
    new AppIcons(missingSourceOrg, "app-icons", {
      metadata: [{ source: "missing.png" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(missingSourceOrg, {
          basePath: orgBasePath,
        }),
      ),
    ).rejects.toThrow("AppIcons source file not found: missing.png")

    const missingBasePathOrg = new Organisation({ name: "Test Org" })
    new AppIcons(missingBasePathOrg, "app-icons", {
      metadata: [{ source: "missing.png" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(missingBasePathOrg, {
          basePath: join(tmpdir(), `pf-app-icons-${randomUUID()}`),
        }),
      ),
    ).rejects.toThrow("AppIcons base path not found:")

    const directorySourceOrg = new Organisation({ name: "Test Org" })
    new AppIcons(directorySourceOrg, "app-icons", {
      metadata: [{ source: "icons" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(directorySourceOrg, {
          basePath: orgBasePath,
        }),
      ),
    ).rejects.toThrow("AppIcons source must be a file: icons")

    const symlinkSourceOrg = new Organisation({ name: "Test Org" })
    const outsideBasePath = join(tmpdir(), `pf-app-icons-${randomUUID()}`)
    mkdirSync(outsideBasePath, { recursive: true })
    writeFileSync(join(outsideBasePath, "outside.png"), "outside")
    symlinkSync(
      join(outsideBasePath, "outside.png"),
      join(orgBasePath, "icons", "linked.png"),
    )
    new AppIcons(symlinkSourceOrg, "app-icons", {
      metadata: [{ source: "icons/linked.png" }],
    })

    await expect(
      Effect.runPromise(
        buildOrganisationFrontendManifest(symlinkSourceOrg, {
          basePath: orgBasePath,
        }),
      ),
    ).rejects.toThrow("AppIcons source must be a relative org-local file")
  })

  it("fails with an actionable error when a frontend plugin provider lacks the manifest builder", async () => {
    class BrokenFrontendClientPlugin extends Construct {
      readonly isFrontendClientPluginManifestProvider = true as const
      readonly frontendManifestPluginCategory = "analytics" as const
    }

    const org = new Organisation({ name: "Test Org" })
    new BrokenFrontendClientPlugin(org, "broken")

    await expect(
      Effect.runPromise(buildOrganisationFrontendManifest(org)),
    ).rejects.toThrow("broken must expose buildFrontendClientPluginManifest()")
  })

  it("fails when a frontend plugin provider returns non-serializable config", async () => {
    const org = new Organisation({ name: "Test Org" })
    new FakeFrontendClientPlugin(
      org,
      "broken",
      {
        module: "@processfocus/plugin-posthog/register-client",
        type: "analytics.posthog",
        config: {
          apiKey: "phc_test_123",
          serialize: () => "nope",
        },
      },
      "analytics",
    )

    await expect(
      Effect.runPromise(buildOrganisationFrontendManifest(org)),
    ).rejects.toThrow(
      "broken frontend client plugin.config.serialize must be JSON-serializable",
    )
  })

  it("fails when one plugin type declares conflicting modules", async () => {
    const org = new Organisation({ name: "Test Org" })
    new FakeFrontendClientPlugin(
      org,
      "first",
      {
        module: "@first-scope/analytics/register-client",
        type: "analytics.shared",
        config: {},
      },
      "analytics",
    )
    new FakeFrontendClientPlugin(
      org,
      "second",
      {
        module: "@second-scope/analytics/register-client",
        type: "analytics.shared",
        config: {},
      },
      "analytics",
    )

    await expect(
      Effect.runPromise(buildOrganisationFrontendManifest(org)),
    ).rejects.toThrow(
      'Frontend plugin type "analytics.shared" declares conflicting modules "@first-scope/analytics/register-client" and "@second-scope/analytics/register-client"',
    )
  })

  it("parses frontend manifests", () => {
    expect(
      parseOrganisationFrontendManifest({
        version: 3,
        organisation: {
          name: "Test Org",
          acronym: "TO",
        },
        appIcons: {
          metadata: [
            {
              url: "/_pf/app-icons/favicon.ico",
              rel: "icon",
              type: "image/x-icon",
            },
          ],
          manifest: [
            {
              src: "/_pf/app-icons/app.png",
              sizes: "192x192",
              type: "image/png",
            },
          ],
        },
        publicFormBranding: {
          headerHtml: " <strong>Test Org</strong> ",
        },
        embed: {
          entries: [],
        },
        plugins: {
          analytics: [
            {
              module: "@processfocus/plugin-posthog/register-client",
              type: "analytics.posthog",
              config: {
                apiKey: "phc_test_123",
                host: "https://us.i.posthog.com",
              },
            },
          ],
          formComponents: [
            {
              module: "@processfocus/plugin-google-drive/register-client",
              type: "google-drive",
            },
          ],
        },
      }),
    ).toEqual({
      version: 3,
      organisation: {
        name: "Test Org",
        acronym: "TO",
      },
      appIcons: {
        metadata: [
          {
            url: "/_pf/app-icons/favicon.ico",
            rel: "icon",
            type: "image/x-icon",
            sizes: undefined,
          },
        ],
        manifest: [
          {
            src: "/_pf/app-icons/app.png",
            sizes: "192x192",
            type: "image/png",
            purpose: undefined,
          },
        ],
      },
      publicFormBranding: {
        headerHtml: " <strong>Test Org</strong> ",
      },
      embed: {
        entries: [],
      },
      processes: {
        documentation: [],
      },
      plugins: {
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [
          {
            module: "@processfocus/plugin-google-drive/register-client",
            type: "google-drive",
          },
        ],
      },
    })
  })

  it("parses missing App Icons metadata as disabled", () => {
    const manifest = parseOrganisationFrontendManifest({
      version: 3,
      embed: { entries: [] },
      plugins: { analytics: [], formComponents: [] },
    })

    expect(manifest.organisation).toEqual({ name: "Process Focus" })
    expect(manifest.appIcons).toEqual({ metadata: [], manifest: [] })
    expect(manifest.publicFormBranding).toBeNull()
  })

  it("rejects stale or malformed frontend manifests", () => {
    expect(() =>
      parseOrganisationFrontendManifest({
        version: 0,
        embed: { entries: [] },
        plugins: { analytics: [], formComponents: [] },
      }),
    ).toThrow("organisation frontend manifest version must be 3, got 0")

    expect(() =>
      parseOrganisationFrontendManifest({
        version: 3,
        embed: { entries: [] },
        plugins: {
          analytics: [
            {
              module: "@processfocus/plugin-posthog/register-client",
              type: "analytics.posthog",
              config: {
                sampleRate: Number.POSITIVE_INFINITY,
              },
            },
          ],
          formComponents: [
            {
              module: "@processfocus/plugin-google-drive/register-client",
              type: "google-drive",
            },
          ],
        },
      }),
    ).toThrow("plugins.analytics[0].config.sampleRate must be a finite number")

    expect(() =>
      parseOrganisationFrontendManifest({
        version: 3,
        embed: { entries: [] },
        plugins: {
          analytics: [],
          formComponents: [{ module: "example/register-client", type: "" }],
        },
      }),
    ).toThrow("plugins.formComponents[0].type must be a non-empty string")

    expect(() =>
      parseOrganisationFrontendManifest({
        version: 3,
        publicFormBranding: {},
        embed: { entries: [] },
        plugins: { analytics: [], formComponents: [] },
      }),
    ).toThrow("publicFormBranding must declare headerHtml or footerHtml")
  })
})
