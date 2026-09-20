#!/usr/bin/env bun

/**
 * Run a command against a temporary demo organisation patched with a probe
 * browser plugin for the frontend boot health scenarios.
 *
 * The temporary organisation is built once from its source, then patched: the
 * organisation frontend manifest gains an analytics plugin and a matching
 * `browser-plugins.json` artifact entry whose bundle is selected by
 * `FRONTEND_E2E_BOOT_HEALTH_ORG_MODE`:
 *
 * - `broken` (default): the bundle throws at import.
 * - `healthy`: the bundle imports, activates, and renders successfully.
 * - `healthy-form`: registers a form renderer, exercising the form-plugin gate.
 *
 * The organisation source is removed afterwards so the serve chain's import
 * bootstrap reuses the patched `dist` artifacts instead of rebuilding them.
 * The patched artifacts must pass frontend build-input validation (sha256
 * integrity, path containment, host interface version), so only the browser
 * boot behaviour differs between the modes — exactly the production failure
 * and success surface these scenarios exist to prove.
 *
 * Usage:
 *   bun apps/frontend-e2e/scripts/run-boot-health-probe-org.ts [--] <command> [args...]
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type ProbeMode = "broken" | "healthy" | "healthy-form"

const probeMode = (): ProbeMode => {
  const value = process.env["FRONTEND_E2E_BOOT_HEALTH_ORG_MODE"] ?? "broken"
  if (value !== "broken" && value !== "healthy" && value !== "healthy-form") {
    throw new Error(
      `FRONTEND_E2E_BOOT_HEALTH_ORG_MODE must be "broken", "healthy", or "healthy-form", got "${value}"`,
    )
  }
  return value
}

const BROKEN_PLUGIN_IDENTITY = "analytics.broken-boot-probe"
const BROKEN_PLUGIN_MODULE = "broken-boot-probe/register-client"
const BROKEN_BUNDLE_PATH = "browser-plugins/broken-boot-probe.js"
const BROKEN_BUNDLE_SOURCE = `// Broken browser plugin bundle for the frontend boot health failure scenario.
throw new Error(
  "Broken browser plugin bundle (${BROKEN_PLUGIN_IDENTITY}) failed to import",
)
export {}
`

const HEALTHY_PLUGIN_IDENTITY = "analytics.boot-health-probe"
const HEALTHY_PLUGIN_MODULE = "boot-health-probe/register-client"
const HEALTHY_BUNDLE_PATH = "browser-plugins/boot-health-probe.js"
const HEALTHY_BUNDLE_RENDERED_TEXT =
  "analytics.boot-health-probe rendered by the organisation plugin"
const HEALTHY_BUNDLE_SOURCE = `// Healthy browser plugin bundle for the frontend boot health scenario.
export const shouldActivate = () => true
export const plugin = {
  id: "${HEALTHY_PLUGIN_IDENTITY}",
  activate: (host) => {
    host.analytics.register({
      type: "${HEALTHY_PLUGIN_IDENTITY}",
      render: () => "${HEALTHY_BUNDLE_RENDERED_TEXT}",
    })
  },
}
export {}
`

interface ProbeOrg {
  readonly category: "analytics" | "formComponents"
  readonly bundlePath: string
  readonly bundleSource: string
  readonly identity: string
  readonly module: string
  readonly tempPrefix: string
}

const probeOrgForMode = (mode: ProbeMode): ProbeOrg =>
  mode === "healthy-form"
    ? {
        category: "formComponents",
        bundlePath: "browser-plugins/form-boot-health-probe.js",
        bundleSource: `export const shouldActivate = () => true
        export const plugin = {
          id: "form.boot-health-probe",
          activate(host) {
            host.formRenderers.register({ type: "boot-health-probe", renderer: () => null })
          },
        }`,
        identity: "form.boot-health-probe",
        module: "form-boot-health-probe/register-client",
        tempPrefix: "pf-boot-health-form-org",
      }
    : mode === "healthy"
      ? {
          category: "analytics",
          bundlePath: HEALTHY_BUNDLE_PATH,
          bundleSource: HEALTHY_BUNDLE_SOURCE,
          identity: HEALTHY_PLUGIN_IDENTITY,
          module: HEALTHY_PLUGIN_MODULE,
          tempPrefix: "pf-boot-health-healthy-org",
        }
      : {
          category: "analytics",
          bundlePath: BROKEN_BUNDLE_PATH,
          bundleSource: BROKEN_BUNDLE_SOURCE,
          identity: BROKEN_PLUGIN_IDENTITY,
          module: BROKEN_PLUGIN_MODULE,
          tempPrefix: "pf-boot-health-broken-org",
        }

const workspaceRoot =
  process.env["NX_WORKSPACE_ROOT"] ??
  resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..")

const portFiles = [
  ".auth-port.json",
  ".graphql-port.json",
  ".frontend-port.json",
]

const usage = `Usage:
  bun apps/frontend-e2e/scripts/run-boot-health-probe-org.ts [--] <command> [args...]

The \`--\` separator is optional; Bun strips it when it directly follows the
script path, and every remaining argument is treated as the wrapped command.
Set FRONTEND_E2E_BOOT_HEALTH_ORG_MODE to "broken" (default), "healthy", or "healthy-form" to
select the probe browser plugin bundle.
`

const main = async () => {
  // Bun strips a `--` that directly follows the script path, so treat every
  // argument as the wrapped command when no separator survives.
  const argv = process.argv.slice(2)
  const separatorIndex = argv.indexOf("--")
  const commandArgs =
    separatorIndex === -1 ? argv : argv.slice(separatorIndex + 1)
  const [command, ...commandRestArgs] = commandArgs
  if (!command) {
    throw new Error(usage)
  }

  const mode = probeMode()
  const probe = probeOrgForMode(mode)
  const sourceOrgPath = resolve(workspaceRoot, "examples/demo")

  const tempOrgPath = mkdtempSync(
    join(tmpdir(), `${probe.tempPrefix}-${basename(sourceOrgPath)}-`),
  )

  try {
    cpSync(sourceOrgPath, tempOrgPath, { recursive: true })
    rmSync(join(tempOrgPath, "db"), { recursive: true, force: true })
    for (const portFile of portFiles) {
      rmSync(
        resolve(process.env["PF_RUNTIME_ROOT"] ?? workspaceRoot, portFile),
        {
          force: true,
        },
      )
    }

    const buildEnv = {
      ...process.env,
      PF_ORG: tempOrgPath,
    }
    const build = spawnSync(
      process.execPath,
      [join(workspaceRoot, "cli/pfcli/src/main.ts"), "build", tempOrgPath],
      {
        cwd: workspaceRoot,
        env: buildEnv,
        stdio: "inherit",
      },
    )
    if (build.error) {
      throw build.error
    }
    if (build.status !== 0) {
      throw new Error(
        `Building the temporary organisation failed with exit code ${String(build.status)}`,
      )
    }

    const distDir = join(tempOrgPath, "dist")
    const manifestPath = join(distDir, "frontend-manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      plugins?: {
        analytics?: Array<Record<string, unknown>>
        formComponents?: Array<Record<string, unknown>>
      }
    }
    const entries = manifest.plugins?.[probe.category]
    if (!Array.isArray(entries)) {
      throw new Error(
        `Built organisation manifest has no plugins.${probe.category} array: ${manifestPath}`,
      )
    }

    const browserPluginsDir = join(distDir, "browser-plugins")
    mkdirSync(browserPluginsDir, { recursive: true })
    const bundlePath = join(distDir, probe.bundlePath)
    writeFileSync(bundlePath, probe.bundleSource)
    const sha256 = createHash("sha256")
      .update(readFileSync(bundlePath))
      .digest("hex")

    // Merge into any existing artifact manifest instead of discarding other
    // organisation browser plugins, and drop stale copies of this scenario's
    // entry so the manifest can never hold a duplicate identity.
    const artifactManifestPath = join(distDir, "browser-plugins.json")
    let artifactPlugins: Array<Record<string, unknown>> = []
    if (existsSync(artifactManifestPath)) {
      const existing = JSON.parse(
        readFileSync(artifactManifestPath, "utf8"),
      ) as { plugins?: Array<Record<string, unknown>> }
      if (Array.isArray(existing.plugins)) {
        artifactPlugins = existing.plugins.filter(
          (plugin) => plugin["identity"] !== probe.identity,
        )
      }
    }
    artifactPlugins.push({
      identity: probe.identity,
      category: probe.category,
      hostInterfaceVersion: 1,
      path: probe.bundlePath,
      sha256,
    })
    writeFileSync(
      artifactManifestPath,
      `${JSON.stringify(
        {
          format: "processfocus/browser-plugins",
          version: 1,
          plugins: artifactPlugins,
        },
        null,
        2,
      )}\n`,
    )

    const dedupedEntries = entries.filter(
      (plugin) => plugin["type"] !== probe.identity,
    )
    dedupedEntries.push({
      module: probe.module,
      type: probe.identity,
      config: {},
    })
    manifest.plugins = { ...manifest.plugins, [probe.category]: dedupedEntries }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    // Remove the organisation source so the serve chain's import bootstrap
    // reuses the patched dist artifacts instead of rebuilding over them.
    rmSync(join(tempOrgPath, "src"), { recursive: true, force: true })
    // Runtime loaders resolve bundled organisations from <org>/org.js.
    // Keep the patched dist artifacts for bootstrap and expose the same real
    // organisation to the worker preflight and the long-running services.
    cpSync(join(distDir, "org.js"), join(tempOrgPath, "org.js"))

    const result = spawnSync(command, commandRestArgs, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PF_ORG: tempOrgPath,
        PF_TEMP_ORG_NODE_MODULES: resolve(workspaceRoot, "node_modules"),
      },
      stdio: "inherit",
    })

    if (result.error) {
      throw result.error
    }

    process.exitCode = result.status ?? 1
  } finally {
    rmSync(tempOrgPath, { recursive: true, force: true })
  }
}

await main()
