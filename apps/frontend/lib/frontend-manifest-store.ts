import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { ORGANISATION_FRONTEND_MANIFEST_VERSION } from "@pf/frontend-manifest"
import {
  type FrontendManifest,
  disabledFrontendManifest,
  parseFrontendManifest,
} from "./frontend-manifest"

export { disabledFrontendManifest }

const FRONTEND_MANIFEST_RELATIVE_PATH = "dist/frontend-manifest.json"
const FRONTEND_MANIFEST_GENERATED_PATH = "lib/generated/frontend-manifest.json"
const FRONTEND_DOCS_GENERATED_PATH = "lib/generated/docs"
const FRONTEND_PUBLIC_APP_ICONS_GENERATED_PATH = "public/_pf/app-icons"
const FRONTEND_PUBLIC_FORM_BRANDING_GENERATED_PATH =
  "public/_pf/public-form-branding"

interface FrontendManifestLocation {
  readonly filePath: string
  readonly docsDirectoryPath: string
  readonly appIconsDirectoryPath: string
  readonly publicFormBrandingDirectoryPath: string
}

let cachedFrontendManifest: FrontendManifest | undefined

const formatFrontendPluginTypes = (manifest: FrontendManifest): string => {
  const pluginTypes = [
    ...manifest.plugins.analytics.map((plugin) => plugin.type),
    ...manifest.plugins.formComponents.map((plugin) => plugin.type),
  ]

  return `${pluginTypes.length} frontend plugin(s)${pluginTypes.length === 0 ? "" : `: ${pluginTypes.join(", ")}`}`
}

const cacheFrontendManifest = (
  manifest: FrontendManifest,
  options?: {
    readonly filePath: string
    readonly source: "loaded" | "missing" | "stale"
  },
): FrontendManifest => {
  cachedFrontendManifest = manifest

  if (!options) {
    return manifest
  }

  if (options.source === "loaded") {
    console.info(
      `[frontend-manifest] loaded ${formatFrontendPluginTypes(manifest)} from ${options.filePath}`,
    )
  } else {
    console.warn(
      `[frontend-manifest] ${options.source} manifest at ${options.filePath}; frontend capabilities disabled`,
    )
  }

  return manifest
}

const getRuntimeRoot = (): string =>
  process.env["PF_RUNTIME_ROOT"] ?? resolve(process.cwd(), "../..")

const getGeneratedFrontendManifestLocation = (): FrontendManifestLocation => ({
  filePath: resolve(process.cwd(), FRONTEND_MANIFEST_GENERATED_PATH),
  docsDirectoryPath: resolve(process.cwd(), FRONTEND_DOCS_GENERATED_PATH),
  appIconsDirectoryPath: resolve(
    process.cwd(),
    FRONTEND_PUBLIC_APP_ICONS_GENERATED_PATH,
  ),
  publicFormBrandingDirectoryPath: resolve(
    process.cwd(),
    FRONTEND_PUBLIC_FORM_BRANDING_GENERATED_PATH,
  ),
})

const getFrontendManifestLocation = ():
  | FrontendManifestLocation
  | undefined => {
  const orgPath = process.env["PF_ORG"]

  if (process.env["NODE_ENV"] === "production" && !orgPath) {
    const generatedLocation = getGeneratedFrontendManifestLocation()
    return generatedLocation
  }

  if (!orgPath) {
    return undefined
  }

  const filePath = orgPath.startsWith("/")
    ? resolve(orgPath, FRONTEND_MANIFEST_RELATIVE_PATH)
    : resolve(getRuntimeRoot(), orgPath, FRONTEND_MANIFEST_RELATIVE_PATH)

  return {
    filePath,
    docsDirectoryPath: resolve(dirname(filePath), "docs"),
    appIconsDirectoryPath: resolve(dirname(filePath), "_pf/app-icons"),
    publicFormBrandingDirectoryPath: resolve(
      dirname(filePath),
      "_pf/public-form-branding",
    ),
  }
}

export const resolveFrontendManifestDocsDirectoryPath = ():
  | string
  | undefined => getFrontendManifestLocation()?.docsDirectoryPath

const PUBLIC_FILE_PREFIXES = [
  {
    prefix: "/_pf/app-icons/",
    directory: (location: FrontendManifestLocation) =>
      location.appIconsDirectoryPath,
  },
  {
    prefix: "/_pf/public-form-branding/",
    directory: (location: FrontendManifestLocation) =>
      location.publicFormBrandingDirectoryPath,
  },
]

export const resolveFrontendManifestPublicFilePath = (
  publicPath: string,
): string | undefined => {
  const route = PUBLIC_FILE_PREFIXES.find(({ prefix }) =>
    publicPath.startsWith(prefix),
  )

  if (!route) {
    return undefined
  }

  const relativePath = publicPath.slice(route.prefix.length)

  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined
  }

  const location = getFrontendManifestLocation()

  if (!location) {
    return undefined
  }

  return resolve(route.directory(location), relativePath)
}

const isStaleFrontendManifestVersion = (value: unknown): boolean => {
  // Non-object manifests still fall through to schema parsing below so we keep
  // malformed JSON shapes noisy while only failing closed on version skew.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const manifest = value as { readonly version?: unknown }

  return manifest.version !== ORGANISATION_FRONTEND_MANIFEST_VERSION
}

const readFrontendManifest = (): FrontendManifest => {
  if (cachedFrontendManifest) {
    return cachedFrontendManifest
  }

  const location = getFrontendManifestLocation()
  if (!location) {
    return cacheFrontendManifest(disabledFrontendManifest)
  }

  const { filePath } = location

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return cacheFrontendManifest(disabledFrontendManifest, {
        filePath,
        source: "missing",
      })
    }

    throw error
  }

  if (isStaleFrontendManifestVersion(parsed)) {
    return cacheFrontendManifest(disabledFrontendManifest, {
      filePath,
      source: "stale",
    })
  }

  return cacheFrontendManifest(parseFrontendManifest(parsed), {
    filePath,
    source: "loaded",
  })
}

export const getFrontendManifest = (): FrontendManifest =>
  readFrontendManifest()

export const clearFrontendManifestCache = (): void => {
  cachedFrontendManifest = undefined
}
