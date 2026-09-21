import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseFrontendManifest } from "../lib/frontend-manifest"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"

// These integration cases launch multiple Bash/Bun processes. The five-second
// unit-test default can kill a child before it returns on the ARM CI runners.
setDefaultTimeout(30_000)

const REPO_ROOT = resolve(__dirname, "../../..")
const SCRIPT_PATH = join(
  REPO_ROOT,
  "apps/frontend/scripts/prepare-build-inputs.sh",
)

let tempDir: string | undefined

const makeWorkspace = (): string => {
  tempDir = mkdtempSync(join(tmpdir(), "frontend-prepare-"))
  mkdirSync(join(tempDir, "apps/frontend/lib/generated"), { recursive: true })
  mkdirSync(join(tempDir, "apps/frontend/public"), { recursive: true })
  mkdirSync(join(tempDir, "apps/frontend/scripts"), { recursive: true })
  symlinkSync(
    join(
      REPO_ROOT,
      "apps/frontend/scripts/generate-organisation-plugin-composition.ts",
    ),
    join(
      tempDir,
      "apps/frontend/scripts/generate-organisation-plugin-composition.ts",
    ),
  )
  return tempDir
}

const manifest = (plugins: unknown = { analytics: [], formComponents: [] }) =>
  `${JSON.stringify({ version: 3, plugins })}\n`

const writeBrowserPluginArtifactTo = (
  artifactRoot: string,
  overrides: Record<string, unknown> = {},
): { readonly bundleName: string; readonly sha256: string } => {
  const source =
    'export const plugin={id:"analytics.posthog",activate:(host)=>host.analytics.register({type:"analytics.posthog",render:()=>null})};export const shouldActivate=()=>true\n'
  const sha256 = createHash("sha256").update(source).digest("hex")
  const bundleName = `${sha256}.js`
  mkdirSync(join(artifactRoot, "browser-plugins"), { recursive: true })
  writeFileSync(join(artifactRoot, "browser-plugins", bundleName), source)
  writeFileSync(
    join(artifactRoot, "browser-plugins.json"),
    `${JSON.stringify({
      format: "processfocus/browser-plugins",
      version: 1,
      plugins: [
        {
          identity: "analytics.posthog",
          category: "analytics",
          hostInterfaceVersion: 1,
          path: `browser-plugins/${bundleName}`,
          sha256,
          ...overrides,
        },
      ],
    })}\n`,
  )
  return { bundleName, sha256 }
}

const addGoogleDriveBrowserPluginArtifactTo = (
  artifactRoot: string,
): { readonly bundleName: string; readonly stylesheetName: string } => {
  const source =
    'export const plugin={id:"google-drive",activate:(host)=>host.formRenderers.register({type:"google-drive",renderer:()=>null})};export const shouldActivate=()=>true\n'
  const sha256 = createHash("sha256").update(source).digest("hex")
  const bundleName = `${sha256}.js`
  const stylesheet = `@source "./${bundleName}";\n`
  const stylesheetSha256 = createHash("sha256").update(stylesheet).digest("hex")
  const stylesheetName = `${stylesheetSha256}.css`
  mkdirSync(join(artifactRoot, "browser-plugins"), { recursive: true })
  writeFileSync(join(artifactRoot, "browser-plugins", bundleName), source)
  writeFileSync(
    join(artifactRoot, "browser-plugins", stylesheetName),
    stylesheet,
  )
  const manifestPath = join(artifactRoot, "browser-plugins.json")
  const artifactManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  artifactManifest.plugins.push({
    identity: "google-drive",
    category: "formComponents",
    hostInterfaceVersion: 1,
    path: `browser-plugins/${bundleName}`,
    sha256,
    preparation: {
      kind: "stylesheet",
      path: `browser-plugins/${stylesheetName}`,
      sha256: stylesheetSha256,
    },
  })
  writeFileSync(manifestPath, `${JSON.stringify(artifactManifest)}\n`)
  return { bundleName, stylesheetName }
}

const writeBrowserPluginArtifact = (
  orgDir: string,
  overrides: Record<string, unknown> = {},
): { readonly bundleName: string; readonly sha256: string } =>
  writeBrowserPluginArtifactTo(join(orgDir, "dist"), overrides)

const runPrepare = async (
  workspaceRoot: string,
  pfOrg: string | undefined,
  { timeoutMs = 20_000 }: { readonly timeoutMs?: number } = {},
): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> => {
  const env = { ...process.env, NX_WORKSPACE_ROOT: workspaceRoot }
  if (pfOrg === undefined) delete env["PF_ORG"]
  else env["PF_ORG"] = pfOrg

  const child = Bun.spawn({
    cmd: ["bash", SCRIPT_PATH],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  let timedOut = false
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error
    }
  }
  const deadline = setTimeout(() => {
    timedOut = true
    killGroup()
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error(`Frontend preparation timed out: ${stderr}`)
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(deadline)
    killGroup()
  }
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe("frontend prepare build inputs", () => {
  test("bounds a stalled generator and cleans up its Bash process group", async () => {
    const workspaceRoot = makeWorkspace()
    const org = join(workspaceRoot, "orgs/stalled")
    mkdirSync(join(org, "dist"), { recursive: true })
    writeFileSync(join(org, "dist/frontend-manifest.json"), manifest())
    const generator = join(
      workspaceRoot,
      "apps/frontend/scripts/generate-organisation-plugin-composition.ts",
    )
    rmSync(generator)
    writeFileSync(generator, "await Bun.sleep(60_000)\n")
    await expect(
      runPrepare(workspaceRoot, org, { timeoutMs: 200 }),
    ).rejects.toThrow("timed out")
  })

  test.each(["orgs/project-b", "orgs/project-a/prod"])(
    "does not reuse plugin inputs when switching to %s",
    async (otherOrg) => {
      const workspaceRoot = makeWorkspace()
      const firstOrg = join(workspaceRoot, "orgs/project-a/dev")
      const secondOrg = join(workspaceRoot, otherOrg)
      for (const org of [firstOrg, secondOrg])
        mkdirSync(join(org, "dist"), { recursive: true })
      const selected = manifest({
        analytics: [
          { module: "@example/analytics", type: "analytics.posthog" },
        ],
        formComponents: [],
      })
      writeFileSync(join(firstOrg, "dist/frontend-manifest.json"), selected)
      const { bundleName } = writeBrowserPluginArtifact(firstOrg)
      expect((await runPrepare(workspaceRoot, firstOrg)).exitCode).toBe(0)
      const staged = join(
        workspaceRoot,
        "apps/frontend/lib/generated/browser-plugins",
        bundleName,
      )
      expect(existsSync(staged)).toBe(true)

      writeFileSync(join(secondOrg, "dist/frontend-manifest.json"), selected)
      const missing = await runPrepare(workspaceRoot, secondOrg)
      expect(missing.exitCode).toBe(1)
      expect(existsSync(staged)).toBe(false)
      expect(
        existsSync(
          join(
            workspaceRoot,
            "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
          ),
        ),
      ).toBe(false)

      writeFileSync(join(secondOrg, "dist/frontend-manifest.json"), manifest())
      expect((await runPrepare(workspaceRoot, secondOrg)).exitCode).toBe(0)
      expect(
        readFileSync(
          join(
            workspaceRoot,
            "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
          ),
          "utf8",
        ),
      ).not.toContain("import(")
    },
  )

  test.each(["frontend-manifest.json", "browser-plugins.json"])(
    "rejects another project's %s through a symlink",
    async (filename) => {
      const workspaceRoot = makeWorkspace()
      const org = join(workspaceRoot, "orgs/project-a")
      const other = join(workspaceRoot, "orgs/project-b")
      for (const directory of [org, other]) {
        mkdirSync(join(directory, "dist"), { recursive: true })
        writeFileSync(
          join(directory, "dist/frontend-manifest.json"),
          manifest({
            analytics: [
              { module: "@example/analytics", type: "analytics.posthog" },
            ],
            formComponents: [],
          }),
        )
        writeBrowserPluginArtifact(directory)
      }
      rmSync(join(org, "dist", filename))
      symlinkSync(join(other, "dist", filename), join(org, "dist", filename))
      const result = await runPrepare(workspaceRoot, org)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(
        "manifest escapes the selected organisation artifact root",
      )
    },
  )

  test("emits deterministic empty composition for a no-plugin build", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    mkdirSync(join(orgDir, "dist/_pf/app-icons"), { recursive: true })
    writeFileSync(join(orgDir, "dist/frontend-manifest.json"), manifest())
    writeFileSync(join(orgDir, "dist/_pf/app-icons/favicon.png"), "current")

    const first = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(first.exitCode).toBe(0)
    const outputPath = join(
      workspaceRoot,
      "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
    )
    const firstOutput = readFileSync(outputPath, "utf8")
    const second = await runPrepare(workspaceRoot, "orgs/test-org")

    expect(second.exitCode).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toBe(firstOutput)
    expect(firstOutput).toContain("return {\n\n  }")
    expect(
      readFileSync(
        join(
          workspaceRoot,
          "apps/frontend/lib/generated/organisation-plugin-composition.json",
        ),
        "utf8",
      ),
    ).toContain('"active": []')
    expect(
      readFileSync(
        join(workspaceRoot, "apps/frontend/public/_pf/app-icons/favicon.png"),
        "utf8",
      ),
    ).toBe("current")
  })

  test("stages validated organisation browser bundles and emits literal imports", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    mkdirSync(join(orgDir, "dist"), { recursive: true })
    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      manifest({
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
            config: { apiKey: "phc_test", host: "https://example.com" },
          },
        ],
        formComponents: [],
      }),
    )
    const { bundleName } = writeBrowserPluginArtifact(orgDir)

    const result = await runPrepare(workspaceRoot, "orgs/test-org")
    const loaders = readFileSync(
      join(
        workspaceRoot,
        "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
      ),
      "utf8",
    )
    const report: unknown = JSON.parse(
      readFileSync(
        join(
          workspaceRoot,
          "apps/frontend/lib/generated/organisation-plugin-composition.json",
        ),
        "utf8",
      ),
    )

    expect(result.exitCode).toBe(0)
    expect(loaders).toContain(`import("./browser-plugins/${bundleName}")`)
    expect(loaders).toContain("artifact.plugin")
    expect(loaders).toContain("artifact.shouldActivate")
    expect(loaders).not.toContain("@processfocus/plugin-posthog")
    expect(
      existsSync(
        join(
          workspaceRoot,
          "apps/frontend/lib/generated/browser-plugins",
          bundleName,
        ),
      ),
    ).toBe(true)
    expect(report).toMatchObject({
      active: [
        {
          source: "organisation-artifact",
          type: "analytics.posthog",
        },
      ],
    })
  })

  test("requires an artifact contract entry for PostHog selections", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    mkdirSync(join(orgDir, "dist"), { recursive: true })
    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      manifest({
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
          },
        ],
        formComponents: [],
      }),
    )

    const missingManifest = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(missingManifest.exitCode).toBe(1)
    expect(missingManifest.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" requires an organisation artifact entry',
    )

    writeFileSync(
      join(orgDir, "dist/browser-plugins.json"),
      `${JSON.stringify({
        format: "processfocus/browser-plugins",
        version: 1,
        plugins: [],
      })}\n`,
    )
    const missingEntry = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(missingEntry.exitCode).toBe(1)
    expect(missingEntry.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" requires an organisation artifact entry',
    )
  })

  test.each([
    {
      module: "@pf/cloud-org/register-access-review-evidence-client",
      type: "cloud-org.access-review-evidence",
    },
    {
      module: "@pf/cloud-org/register-environment-usage-costs-client",
      type: "cloud-org.environment-usage-costs",
    },
  ])(
    "requires an artifact contract entry for $type",
    async ({ module, type }) => {
      const workspaceRoot = makeWorkspace()
      const orgDir = join(workspaceRoot, "orgs/test-org")
      mkdirSync(join(orgDir, "dist"), { recursive: true })
      writeFileSync(
        join(orgDir, "dist/frontend-manifest.json"),
        manifest({
          analytics: [],
          formComponents: [{ module, type }],
        }),
      )
      writeFileSync(
        join(orgDir, "dist/browser-plugins.json"),
        `${JSON.stringify({
          format: "processfocus/browser-plugins",
          version: 1,
          plugins: [],
        })}\n`,
      )

      const result = await runPrepare(workspaceRoot, "orgs/test-org")

      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(
        `browser plugin "${type}" requires an organisation artifact entry`,
      )
    },
  )

  test("stages distinct artifact paths without basename collisions", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    const artifactRoot = join(orgDir, "dist")
    const firstSource =
      'export const plugin={id:"analytics.posthog",activate:()=>undefined};export const shouldActivate=()=>true\n'
    const secondSource =
      'export const plugin={id:"form.custom",activate:()=>undefined};export const shouldActivate=()=>true\n'
    const firstSha256 = createHash("sha256").update(firstSource).digest("hex")
    const secondSha256 = createHash("sha256").update(secondSource).digest("hex")
    mkdirSync(join(artifactRoot, "a"), { recursive: true })
    mkdirSync(join(artifactRoot, "b"), { recursive: true })
    writeFileSync(join(artifactRoot, "a/plugin.js"), firstSource)
    writeFileSync(join(artifactRoot, "b/plugin.js"), secondSource)
    writeFileSync(
      join(artifactRoot, "frontend-manifest.json"),
      manifest({
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
          },
        ],
        formComponents: [{ module: "custom", type: "form.custom" }],
      }),
    )
    writeFileSync(
      join(artifactRoot, "browser-plugins.json"),
      `${JSON.stringify({
        format: "processfocus/browser-plugins",
        version: 1,
        plugins: [
          {
            identity: "analytics.posthog",
            category: "analytics",
            hostInterfaceVersion: 1,
            path: "a/plugin.js",
            sha256: firstSha256,
          },
          {
            identity: "form.custom",
            category: "formComponents",
            hostInterfaceVersion: 1,
            path: "b/plugin.js",
            sha256: secondSha256,
          },
        ],
      })}\n`,
    )

    const result = await runPrepare(workspaceRoot, "orgs/test-org")
    const stagedDirectory = join(
      workspaceRoot,
      "apps/frontend/lib/generated/browser-plugins",
    )
    const loaders = readFileSync(
      join(
        workspaceRoot,
        "apps/frontend/lib/generated/organisation-plugin-loaders.tsx",
      ),
      "utf8",
    )

    expect(result.exitCode).toBe(0)
    expect(
      readFileSync(join(stagedDirectory, `${firstSha256}.js`), "utf8"),
    ).toBe(firstSource)
    expect(
      readFileSync(join(stagedDirectory, `${secondSha256}.js`), "utf8"),
    ).toBe(secondSource)
    expect(loaders).toContain(`./browser-plugins/${firstSha256}.js`)
    expect(loaders).toContain(`./browser-plugins/${secondSha256}.js`)
  })

  test("rejects invalid organisation browser artifact files with plugin-specific errors", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    mkdirSync(join(orgDir, "dist"), { recursive: true })
    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      manifest({
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
          },
        ],
        formComponents: [],
      }),
    )

    writeBrowserPluginArtifact(orgDir, { path: "browser-plugins/missing.js" })
    const missing = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" file is missing',
    )

    writeBrowserPluginArtifact(orgDir, { sha256: "b".repeat(64) })
    const integrity = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(integrity.exitCode).toBe(1)
    expect(integrity.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" integrity mismatch',
    )

    writeBrowserPluginArtifact(orgDir, { hostInterfaceVersion: 2 })
    const incompatible = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(incompatible.exitCode).toBe(1)
    expect(incompatible.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" requires host interface version 2, but the Dashboard provides 1',
    )

    writeBrowserPluginArtifact(orgDir, { path: "../posthog.js" })
    const escaping = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(escaping.exitCode).toBe(1)
    expect(escaping.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" path must stay within the artifact root',
    )

    const { bundleName } = writeBrowserPluginArtifact(orgDir)
    const externalBundlePath = join(workspaceRoot, "outside-artifact.js")
    writeFileSync(
      externalBundlePath,
      readFileSync(join(orgDir, "dist/browser-plugins", bundleName)),
    )
    rmSync(join(orgDir, "dist/browser-plugins", bundleName))
    symlinkSync(
      externalBundlePath,
      join(orgDir, "dist/browser-plugins", bundleName),
    )
    const symbolicLinkEscape = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(symbolicLinkEscape.exitCode).toBe(1)
    expect(symbolicLinkEscape.stderr.toString()).toContain(
      'browser plugin "analytics.posthog" path escapes the artifact root through a symbolic link',
    )

    writeBrowserPluginArtifact(orgDir)
    const artifactManifestPath = join(orgDir, "dist/browser-plugins.json")
    const duplicateManifest = JSON.parse(
      readFileSync(artifactManifestPath, "utf8"),
    )
    duplicateManifest.plugins.push(duplicateManifest.plugins[0])
    writeFileSync(
      artifactManifestPath,
      `${JSON.stringify(duplicateManifest)}\n`,
    )
    const duplicate = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(duplicate.exitCode).toBe(1)
    expect(duplicate.stderr.toString()).toContain(
      'duplicate identity "analytics.posthog"',
    )
  })

  test("rejects missing or modified browser preparation artifacts", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    const artifactRoot = join(orgDir, "dist")
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(
      join(artifactRoot, "frontend-manifest.json"),
      manifest({
        analytics: [
          {
            module: "@processfocus/plugin-posthog/register-client",
            type: "analytics.posthog",
          },
        ],
        formComponents: [
          {
            module: "@processfocus/plugin-google-drive/register-client",
            type: "google-drive",
          },
        ],
      }),
    )

    writeBrowserPluginArtifact(orgDir)
    const { stylesheetName } =
      addGoogleDriveBrowserPluginArtifactTo(artifactRoot)
    const stylesheetPath = join(artifactRoot, "browser-plugins", stylesheetName)
    rmSync(stylesheetPath)
    const missing = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain(
      'browser plugin "google-drive" preparation file is missing',
    )

    writeBrowserPluginArtifact(orgDir)
    const regenerated = addGoogleDriveBrowserPluginArtifactTo(artifactRoot)
    writeFileSync(
      join(artifactRoot, "browser-plugins", regenerated.stylesheetName),
      "modified",
    )
    const modified = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(modified.exitCode).toBe(1)
    expect(modified.stderr.toString()).toContain(
      'browser plugin "google-drive" preparation integrity mismatch',
    )
  })

  test("preserves rule-bearing and rule-free embed definitions", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    const sourcePath = join(orgDir, "dist/frontend-manifest.json")
    const structuredRule = {
      condition: {
        _tag: "blank",
        value: { _tag: "field", path: ["name"] },
      },
      effects: [{ target: ["details"], state: { disabled: true } }],
    }
    const embedEntry = {
      stepPath: "/enrolment/Submit",
      processName: "Enrolment",
      processPath: "/enrolment",
      mutationName: "startEnrolment",
      inputTypeName: "EnrolmentSubmit",
      totalFields: 2,
      formDefinition: {
        components: {
          name: { _tag: "text", field: "name", label: "Name" },
          details: { _tag: "text", field: "details", label: "Details" },
        },
        rules: [structuredRule],
      },
      defaultValues: { name: "", details: "" },
      jsonSchema: { type: "object" },
      sites: ["https://school.example.com"],
      thankYou: "Thanks",
    }
    const sourceManifest = {
      version: 3,
      embed: {
        entries: [
          embedEntry,
          {
            ...embedEntry,
            stepPath: "/enrolment/Rule free",
            formDefinition: {
              ...embedEntry.formDefinition,
              rules: [],
            },
          },
        ],
      },
      plugins: { analytics: [], formComponents: [] },
    }
    mkdirSync(join(orgDir, "dist"), { recursive: true })
    writeFileSync(sourcePath, `${JSON.stringify(sourceManifest)}\n`)

    const result = await runPrepare(workspaceRoot, "orgs/test-org")
    const staged: unknown = JSON.parse(
      readFileSync(
        join(
          workspaceRoot,
          "apps/frontend/lib/generated/frontend-manifest.json",
        ),
        "utf8",
      ),
    )

    expect(result.exitCode).toBe(0)
    expect(staged).toEqual(sourceManifest)
    expect(
      parseFrontendManifest(staged).embed.entries.map(
        (entry) => entry.formDefinition?.rules,
      ),
    ).toEqual([[structuredRule], []])
  })

  test("rejects an unknown plugin instead of silently omitting it", async () => {
    const workspaceRoot = makeWorkspace()
    const orgDir = join(workspaceRoot, "orgs/test-org")
    mkdirSync(join(orgDir, "dist"), { recursive: true })
    writeFileSync(
      join(orgDir, "dist/frontend-manifest.json"),
      manifest({
        analytics: [],
        formComponents: [{ module: "@private/new-plugin", type: "new-plugin" }],
      }),
    )
    const result = await runPrepare(workspaceRoot, "orgs/test-org")
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      'browser plugin "new-plugin" requires an organisation artifact entry',
    )
  })

  test("cleans generated composition when PF_ORG is unset", async () => {
    const workspaceRoot = makeWorkspace()
    const generated = join(workspaceRoot, "apps/frontend/lib/generated")
    for (const file of [
      "frontend-manifest.json",
      "organisation-plugin-loaders.tsx",
      "organisation-plugin-preparation.ts",
      "organisation-plugin-composition.json",
    ]) {
      writeFileSync(join(generated, file), "stale")
    }

    const result = await runPrepare(workspaceRoot, undefined)

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(generated, "frontend-manifest.json"))).toBe(false)
    expect(
      existsSync(join(generated, "organisation-plugin-composition.json")),
    ).toBe(false)
  })

  test("fails with a rebuild hint when the dist manifest is missing", async () => {
    const workspaceRoot = makeWorkspace()
    mkdirSync(join(workspaceRoot, "orgs/test-org"), { recursive: true })

    const result = await runPrepare(workspaceRoot, "orgs/test-org")

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain(
      "Run pfcli build orgs/test-org before building the frontend.",
    )
  })
})
