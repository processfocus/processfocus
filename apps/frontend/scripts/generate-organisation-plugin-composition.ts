import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import {
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
  type BrowserPluginArtifactEntry,
  parseBrowserPluginArtifactManifest,
} from "@pf/frontend-manifest"
import { FRONTEND_PLUGIN_HOST_INTERFACE_VERSION } from "@pf/frontend-plugin-host"

type PluginCategory = "analytics" | "formComponents"

export interface ManifestSelection {
  readonly category: PluginCategory
  readonly module: string
  readonly type: string
}

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value
}

const ensureString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

const readManifestSelections = (
  manifestPath: string,
): readonly ManifestSelection[] => {
  const manifest = ensureRecord(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  )
  const pluginsValue = manifest["plugins"]
  if (pluginsValue === undefined) return []
  const plugins = ensureRecord(pluginsValue, `${manifestPath}.plugins`)

  return (["analytics", "formComponents"] as const).flatMap((category) => {
    const values = plugins[category] ?? []
    if (!Array.isArray(values)) {
      throw new Error(`${manifestPath}.plugins.${category} must be an array`)
    }
    return values.map((value, index) => {
      const path = `${manifestPath}.plugins.${category}[${index}]`
      const selection = ensureRecord(value, path)
      return {
        category,
        module: ensureString(selection["module"], `${path}.module`),
        type: ensureString(selection["type"], `${path}.type`),
      }
    })
  })
}

type PreparedBrowserPluginPreparation = NonNullable<
  BrowserPluginArtifactEntry["preparation"]
> & {
  readonly stagedPath: string
}

interface PreparedBrowserPluginArtifact
  extends Omit<BrowserPluginArtifactEntry, "preparation"> {
  readonly stagedPath: string
  readonly preparation?: PreparedBrowserPluginPreparation
}

const assertRequiredBrowserPluginArtifacts = (options: {
  readonly selections: readonly ManifestSelection[]
  readonly artifactIdentities: ReadonlySet<string>
  readonly artifactManifestPath: string
}): void => {
  for (const selection of options.selections) {
    if (!options.artifactIdentities.has(selection.type)) {
      throw new Error(
        `browser plugin "${selection.type}" requires an organisation artifact entry in ${options.artifactManifestPath}`,
      )
    }
  }
}

type BrowserPluginArtifactPathField = "path" | "preparation.path"

const stageVerifiedBrowserPluginArtifact = (options: {
  readonly identity: string
  readonly artifactPath: string
  readonly artifactPathField: BrowserPluginArtifactPathField
  readonly artifactRoot: string
  readonly expectedSha256: string
  readonly outputDirectory: string
  readonly realArtifactRoot: string
  readonly stagedExtension: ".css" | ".js"
}): string => {
  const resolvedArtifactPath = resolve(
    options.artifactRoot,
    options.artifactPath,
  )
  if (!resolvedArtifactPath.startsWith(`${options.artifactRoot}${sep}`)) {
    throw new Error(
      `browser plugin "${options.identity}" ${options.artifactPathField} escapes the artifact root: ${options.artifactPath}`,
    )
  }
  if (!existsSync(resolvedArtifactPath)) {
    const artifactKind =
      options.artifactPathField === "path" ? "file" : "preparation file"
    throw new Error(
      `browser plugin "${options.identity}" ${artifactKind} is missing: ${options.artifactPath}`,
    )
  }

  const realArtifactPath = realpathSync(resolvedArtifactPath)
  if (!realArtifactPath.startsWith(`${options.realArtifactRoot}${sep}`)) {
    throw new Error(
      `browser plugin "${options.identity}" ${options.artifactPathField} escapes the artifact root through a symbolic link: ${options.artifactPath}`,
    )
  }
  if (!statSync(realArtifactPath).isFile()) {
    throw new Error(
      `browser plugin "${options.identity}" ${options.artifactPathField} is not a file: ${options.artifactPath}`,
    )
  }

  const actualSha256 = createHash("sha256")
    .update(readFileSync(realArtifactPath))
    .digest("hex")
  if (actualSha256 !== options.expectedSha256) {
    const artifactKind =
      options.artifactPathField === "path" ? "" : "preparation "
    throw new Error(
      `browser plugin "${options.identity}" ${artifactKind}integrity mismatch for ${options.artifactPath}: expected ${options.expectedSha256}, got ${actualSha256}`,
    )
  }

  mkdirSync(options.outputDirectory, { recursive: true })
  const stagedPath = resolve(
    options.outputDirectory,
    `${options.expectedSha256}${options.stagedExtension}`,
  )
  copyFileSync(realArtifactPath, stagedPath)
  return stagedPath
}

const prepareBrowserPluginArtifacts = (options: {
  readonly manifestPath: string
  readonly selections: readonly ManifestSelection[]
  readonly outputModulePath: string
}): readonly PreparedBrowserPluginArtifact[] => {
  const artifactRoot = dirname(options.manifestPath)
  const artifactManifestPath = resolve(
    artifactRoot,
    BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
  )
  const outputDirectory = resolve(
    dirname(options.outputModulePath),
    "browser-plugins",
  )
  rmSync(outputDirectory, { recursive: true, force: true })

  const realArtifactRoot = realpathSync(artifactRoot)
  for (const path of [options.manifestPath, artifactManifestPath]) {
    if (
      existsSync(path) &&
      !realpathSync(path).startsWith(`${realArtifactRoot}${sep}`)
    ) {
      throw new Error(
        `plugin manifest escapes the selected organisation artifact root: ${path}`,
      )
    }
  }

  if (!existsSync(artifactManifestPath)) {
    assertRequiredBrowserPluginArtifacts({
      selections: options.selections,
      artifactIdentities: new Set(),
      artifactManifestPath,
    })
    return []
  }

  let manifest: ReturnType<typeof parseBrowserPluginArtifactManifest>
  try {
    manifest = parseBrowserPluginArtifactManifest(
      JSON.parse(readFileSync(artifactManifestPath, "utf8")),
    )
  } catch (cause) {
    throw new Error(
      `browser plugin artifact manifest at ${artifactManifestPath} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }

  const selectionsByIdentity = new Map<string, ManifestSelection>()
  for (const selection of options.selections) {
    if (selectionsByIdentity.has(selection.type)) {
      throw new Error(
        `frontend manifest has duplicate browser plugin identity "${selection.type}"`,
      )
    }
    selectionsByIdentity.set(selection.type, selection)
  }

  assertRequiredBrowserPluginArtifacts({
    selections: options.selections,
    artifactIdentities: new Set(
      manifest.plugins.map((plugin) => plugin.identity),
    ),
    artifactManifestPath,
  })

  const resolvedArtifactRoot = resolve(artifactRoot)

  return manifest.plugins.map((plugin) => {
    const selection = selectionsByIdentity.get(plugin.identity)
    if (!selection) {
      throw new Error(
        `browser plugin "${plugin.identity}" has no matching frontend manifest selection`,
      )
    }
    if (selection.category !== plugin.category) {
      throw new Error(
        `browser plugin "${plugin.identity}" declares category "${plugin.category}" but its frontend manifest selection is "${selection.category}"`,
      )
    }
    if (
      plugin.hostInterfaceVersion !== FRONTEND_PLUGIN_HOST_INTERFACE_VERSION
    ) {
      throw new Error(
        `browser plugin "${plugin.identity}" requires host interface version ${plugin.hostInterfaceVersion}, but the Dashboard provides ${FRONTEND_PLUGIN_HOST_INTERFACE_VERSION}`,
      )
    }

    const stagedPath = stageVerifiedBrowserPluginArtifact({
      identity: plugin.identity,
      artifactPath: plugin.path,
      artifactPathField: "path",
      artifactRoot: resolvedArtifactRoot,
      expectedSha256: plugin.sha256,
      outputDirectory,
      realArtifactRoot,
      stagedExtension: ".js",
    })

    const preparation = plugin.preparation
    if (preparation === undefined) {
      return { ...plugin, stagedPath }
    }
    const stagedPreparationPath = stageVerifiedBrowserPluginArtifact({
      identity: plugin.identity,
      artifactPath: preparation.path,
      artifactPathField: "preparation.path",
      artifactRoot: resolvedArtifactRoot,
      expectedSha256: preparation.sha256,
      outputDirectory,
      realArtifactRoot,
      stagedExtension: ".css",
    })

    return {
      ...plugin,
      stagedPath,
      preparation: {
        ...preparation,
        stagedPath: stagedPreparationPath,
      },
    }
  })
}

const importSpecifier = (fromFile: string, target: string): string => {
  const path = relative(dirname(fromFile), target).split(sep).join("/")
  return path.startsWith(".") ? path : `./${path}`
}

const generateModule = (
  artifactEntries: readonly PreparedBrowserPluginArtifact[],
  outputPath: string,
): string => {
  const artifactLoaders = artifactEntries.map((entry, index) => {
    const entrypoint = JSON.stringify(
      importSpecifier(outputPath, entry.stagedPath),
    )
    const identity = JSON.stringify(entry.identity)
    return `const artifactLoader${index} = Object.assign(
  async (): Promise<boolean> => {
    const artifact = await import(${entrypoint})
    await host.activate(${identity}, artifact.plugin)
    return true
  }, {
    shouldActivate: async (config?: unknown) => {
      const artifact = await import(${entrypoint})
      return artifact.shouldActivate(config, process.env["NODE_ENV"])
    },
  },
)`
  })
  const artifactProperties = artifactEntries
    .map(
      (entry, index) =>
        `    ${JSON.stringify(entry.identity)}: artifactLoader${index},`,
    )
    .join("\n")
  const allLoaders = artifactLoaders
  const allProperties = artifactProperties

  return `// Generated by prepare-build-inputs. Do not edit.\nimport type { FrontendPluginLoaderMap } from "../frontend-plugin-loaders"\nimport type { OrganisationFrontendPluginHost } from "../organisation-plugin-loaders"\n\nexport const createOrganisationFrontendPluginLoaders = (\n  host: OrganisationFrontendPluginHost,\n): FrontendPluginLoaderMap => {\n${allLoaders.map((loader) => `  ${loader.replaceAll("\n", "\n  ")}`).join("\n\n")}\n\n  return {\n${allProperties}\n  }\n}\n`
}

const generatePreparationModule = (
  artifactEntries: readonly PreparedBrowserPluginArtifact[],
  outputPath: string,
): string => {
  const artifactImports = artifactEntries.flatMap((entry) =>
    entry.preparation === undefined
      ? []
      : [
          `import ${JSON.stringify(importSpecifier(outputPath, entry.preparation.stagedPath))}`,
        ],
  )
  const imports = artifactImports.join("\n")
  return `// Generated by prepare-build-inputs. Do not edit.\n${imports}${imports ? "\n" : ""}`
}

export const generateOrganisationFrontendPluginComposition = (options: {
  readonly manifestPath: string
  readonly outputModulePath: string
  readonly outputPreparationModulePath: string
  readonly outputReportPath: string
}): void => {
  const selections = readManifestSelections(options.manifestPath)
  const artifactEntries = prepareBrowserPluginArtifacts({
    manifestPath: options.manifestPath,
    selections,
    outputModulePath: options.outputModulePath,
  })
  writeFileSync(
    options.outputModulePath,
    generateModule(artifactEntries, options.outputModulePath),
  )
  writeFileSync(
    options.outputPreparationModulePath,
    generatePreparationModule(
      artifactEntries,
      options.outputPreparationModulePath,
    ),
  )
  writeFileSync(
    options.outputReportPath,
    `${JSON.stringify(
      {
        version: 1,
        active: [
          ...artifactEntries.map((entry) => ({
            source: "organisation-artifact",
            category: entry.category,
            type: entry.identity,
            path: entry.path,
            sha256: entry.sha256,
            hostInterfaceVersion: entry.hostInterfaceVersion,
          })),
        ],
      },
      null,
      2,
    )}\n`,
  )
}

if (import.meta.main) {
  const [
    manifestPath,
    outputModulePath,
    outputPreparationModulePath,
    outputReportPath,
  ] = process.argv.slice(2)
  if (
    !manifestPath ||
    !outputModulePath ||
    !outputPreparationModulePath ||
    !outputReportPath
  ) {
    throw new Error(
      "usage: generate-organisation-plugin-composition <manifest> <output-module> <output-preparation-module> <output-report>",
    )
  }
  generateOrganisationFrontendPluginComposition({
    manifestPath,
    outputModulePath,
    outputPreparationModulePath,
    outputReportPath,
  })
}
