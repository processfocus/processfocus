export const BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT =
  "processfocus/browser-plugins"
export const BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION = 1 as const
export const BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE = "browser-plugins.json"

export const BROWSER_PLUGIN_CATEGORIES = [
  "analytics",
  "formComponents",
] as const

export type BrowserPluginCategory = (typeof BROWSER_PLUGIN_CATEGORIES)[number]

export const isBrowserPluginCategory = (
  value: unknown,
): value is BrowserPluginCategory =>
  BROWSER_PLUGIN_CATEGORIES.some((category) => value === category)

export interface BrowserPluginArtifactEntry {
  readonly identity: string
  readonly category: BrowserPluginCategory
  readonly hostInterfaceVersion: number
  readonly path: string
  readonly sha256: string
  readonly preparation?: BrowserPluginPreparationArtifact
}

export interface BrowserPluginPreparationArtifact {
  readonly kind: "stylesheet"
  readonly path: string
  readonly sha256: string
}

export interface BrowserPluginArtifactManifest {
  readonly format: typeof BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT
  readonly version: typeof BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION
  readonly plugins: ReadonlyArray<BrowserPluginArtifactEntry>
}

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return { ...value }
}

const ensureNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value.trim()
}

const ensureCategory = (
  value: unknown,
  path: string,
): BrowserPluginCategory => {
  if (!isBrowserPluginCategory(value)) {
    const allowedCategories = BROWSER_PLUGIN_CATEGORIES.map((category) =>
      JSON.stringify(category),
    ).join(" or ")
    throw new Error(`${path} must be ${allowedCategories}`)
  }
  return value
}

const ensureArtifactPath = (
  value: unknown,
  identity: string,
  label = "path",
): string => {
  const artifactPath = ensureNonEmptyString(
    value,
    `browser plugin "${identity}" ${label}`,
  )
  const segments = artifactPath.split("/")

  if (
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `browser plugin "${identity}" ${label} must stay within the artifact root: ${artifactPath}`,
    )
  }

  return artifactPath
}

const parsePreparation = (
  value: unknown,
  identity: string,
): BrowserPluginPreparationArtifact => {
  const preparation = ensureRecord(
    value,
    `browser plugin "${identity}" preparation`,
  )
  if (preparation["kind"] !== "stylesheet") {
    throw new Error(
      `browser plugin "${identity}" preparation.kind must be "stylesheet"`,
    )
  }
  const sha256 = ensureNonEmptyString(
    preparation["sha256"],
    `browser plugin "${identity}" preparation.sha256`,
  )
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `browser plugin "${identity}" preparation.sha256 must be a 64-character hex string`,
    )
  }

  return {
    kind: "stylesheet",
    path: ensureArtifactPath(preparation["path"], identity, "preparation.path"),
    sha256,
  }
}

const parseEntry = (
  value: unknown,
  index: number,
): BrowserPluginArtifactEntry => {
  const path = `browser plugin artifact manifest.plugins[${index}]`
  const entry = ensureRecord(value, path)
  const identity = ensureNonEmptyString(entry["identity"], `${path}.identity`)
  const hostInterfaceVersion = entry["hostInterfaceVersion"]
  if (
    typeof hostInterfaceVersion !== "number" ||
    !Number.isInteger(hostInterfaceVersion) ||
    hostInterfaceVersion < 1
  ) {
    throw new Error(
      `browser plugin "${identity}" hostInterfaceVersion must be a positive integer`,
    )
  }
  const sha256 = ensureNonEmptyString(
    entry["sha256"],
    `browser plugin "${identity}" sha256`,
  )
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `browser plugin "${identity}" sha256 must be a 64-character hex string`,
    )
  }

  return {
    identity,
    category: ensureCategory(
      entry["category"],
      `browser plugin "${identity}" category`,
    ),
    hostInterfaceVersion,
    path: ensureArtifactPath(entry["path"], identity),
    sha256,
    ...(entry["preparation"] !== undefined && {
      preparation: parsePreparation(entry["preparation"], identity),
    }),
  }
}

export const parseBrowserPluginArtifactManifest = (
  value: unknown,
): BrowserPluginArtifactManifest => {
  const manifest = ensureRecord(value, "browser plugin artifact manifest")
  if (manifest["format"] !== BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT) {
    throw new Error(
      `browser plugin artifact manifest format must be ${BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT}`,
    )
  }
  if (manifest["version"] !== BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION) {
    throw new Error(
      `browser plugin artifact manifest version must be ${String(BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION)}`,
    )
  }
  if (!Array.isArray(manifest["plugins"])) {
    throw new Error("browser plugin artifact manifest.plugins must be an array")
  }

  const plugins = manifest["plugins"].map(parseEntry)
  const identities = new Set<string>()
  for (const plugin of plugins) {
    if (identities.has(plugin.identity)) {
      throw new Error(
        `browser plugin artifact manifest has duplicate identity "${plugin.identity}"`,
      )
    }
    identities.add(plugin.identity)
  }

  return {
    format: BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
    version: BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
    plugins,
  }
}
