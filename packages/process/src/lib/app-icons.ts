import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"
import { Construct, type IConstruct } from "constructs"
import type { Organisation } from "./organisation"

const APP_ICONS_PUBLIC_PATH_PREFIX = "/_pf/app-icons/"

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
])

const VALID_MANIFEST_ICON_PURPOSES = new Set(["any", "maskable", "monochrome"])

class AppIconsSourceError extends Error {}

const resolveExistingAppIconsBasePath = (rootPath: string): string => {
  try {
    return realpathSync(rootPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppIconsSourceError(
        `AppIcons base path not found: ${rootPath}`,
        { cause: error },
      )
    }

    throw error
  }
}

export interface AppIconMetadataIconProps {
  readonly source: string
  readonly publicPath?: string | undefined
  readonly rel?: string | undefined
  readonly type?: string | undefined
  readonly sizes?: string | undefined
}

export interface AppIconManifestIconProps {
  readonly source: string
  readonly sizes: string
  readonly publicPath?: string | undefined
  readonly type?: string | undefined
  readonly purpose?: string | undefined
}

export interface AppIconsProps {
  readonly metadata?: ReadonlyArray<AppIconMetadataIconProps> | undefined
  readonly manifest?: ReadonlyArray<AppIconManifestIconProps> | undefined
}

export interface OrganisationFrontendManifestMetadataIcon {
  readonly url: string
  readonly rel: string
  readonly type?: string | undefined
  readonly sizes?: string | undefined
}

export interface OrganisationFrontendManifestWebAppManifestIcon {
  readonly src: string
  readonly sizes: string
  readonly type?: string | undefined
  readonly purpose?: string | undefined
}

export interface OrganisationFrontendManifestAppIcons {
  readonly metadata: ReadonlyArray<OrganisationFrontendManifestMetadataIcon>
  readonly manifest: ReadonlyArray<OrganisationFrontendManifestWebAppManifestIcon>
}

export interface OrganisationFrontendManifestAppIconFile {
  readonly sourcePath: string
  readonly publicPath: string
}

export class AppIcons extends Construct {
  readonly isAppIcons = true as const
  readonly metadata: ReadonlyArray<AppIconMetadataIconProps>
  readonly manifest: ReadonlyArray<AppIconManifestIconProps>

  constructor(scope: IConstruct, id: string, props: AppIconsProps) {
    super(scope, id)

    if ((props.metadata?.length ?? 0) + (props.manifest?.length ?? 0) === 0) {
      throw new Error(`AppIcons "${id}" must declare at least one icon`)
    }

    for (const icon of props.manifest ?? []) {
      if (icon.sizes.trim().length === 0) {
        throw new Error(`AppIcons "${id}" manifest icons must declare sizes`)
      }

      const purposeTokens = icon.purpose
        ?.split(" ")
        .filter((token) => token.length > 0)
      if (
        purposeTokens &&
        (purposeTokens.length === 0 ||
          purposeTokens.some(
            (token) => !VALID_MANIFEST_ICON_PURPOSES.has(token),
          ))
      ) {
        throw new Error(
          `AppIcons "${id}" manifest icon purpose must use any, maskable, or monochrome`,
        )
      }
    }

    this.metadata = props.metadata ?? []
    this.manifest = props.manifest ?? []
  }
}

const ensureAppIconsPublicPath = (publicPath: string): string => {
  if (!publicPath.startsWith(APP_ICONS_PUBLIC_PATH_PREFIX)) {
    throw new Error(
      `AppIcons publicPath must be inside ${APP_ICONS_PUBLIC_PATH_PREFIX}`,
    )
  }

  const relativePath = publicPath.slice(APP_ICONS_PUBLIC_PATH_PREFIX.length)

  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `AppIcons publicPath must be inside ${APP_ICONS_PUBLIC_PATH_PREFIX}`,
    )
  }

  return publicPath
}

const normalizeLocalSourcePath = (
  source: string,
  basePath?: string,
): string => {
  if (source.trim().length === 0) {
    throw new AppIconsSourceError("AppIcons source must be a non-empty string")
  }

  if (isAbsolute(source)) {
    throw new AppIconsSourceError(
      "AppIcons source must be a relative org-local file",
    )
  }

  const rootPath = resolve(basePath ?? process.cwd())
  const sourcePath = resolve(rootPath, source)
  const relativeSourcePath = relative(rootPath, sourcePath)

  if (
    relativeSourcePath.length === 0 ||
    relativeSourcePath === ".." ||
    relativeSourcePath.startsWith(`..${sep}`) ||
    isAbsolute(relativeSourcePath)
  ) {
    throw new AppIconsSourceError(
      "AppIcons source must be a relative org-local file",
    )
  }

  try {
    const rootRealPath = resolveExistingAppIconsBasePath(rootPath)
    const stats = statSync(sourcePath)
    if (!stats.isFile()) {
      throw new AppIconsSourceError(`AppIcons source must be a file: ${source}`)
    }

    const realSourcePath = realpathSync(sourcePath)
    const relativeRealSourcePath = relative(rootRealPath, realSourcePath)

    if (
      relativeRealSourcePath.length === 0 ||
      relativeRealSourcePath === ".." ||
      relativeRealSourcePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeRealSourcePath)
    ) {
      throw new AppIconsSourceError(
        "AppIcons source must be a relative org-local file",
      )
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppIconsSourceError(
        `AppIcons source file not found: ${source}`,
        {
          cause: error,
        },
      )
    }

    if (error instanceof AppIconsSourceError) {
      throw error
    }

    throw new Error(`Failed to inspect AppIcons source file: ${source}`, {
      cause: error,
    })
  }

  return sourcePath
}

const inferMimeType = (source: string): string | undefined =>
  MIME_TYPES_BY_EXTENSION.get(extname(source).toLowerCase())

const generatedPublicPath = (sourcePath: string): string => {
  let contents: Buffer

  try {
    contents = readFileSync(sourcePath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`AppIcons source file not found: ${sourcePath}`, {
        cause: error,
      })
    }

    throw new Error(`Failed to read AppIcons source file: ${sourcePath}`, {
      cause: error,
    })
  }

  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16)
  const extension = extname(sourcePath)
  const name = basename(sourcePath, extension)

  return `${APP_ICONS_PUBLIC_PATH_PREFIX}${name}-${hash}${extension}`
}

const findAppIconsConstructs = (org: Organisation): ReadonlyArray<AppIcons> =>
  org.node.findAll().filter((construct): construct is AppIcons => {
    const casted = construct as { readonly isAppIcons?: unknown }
    return casted.isAppIcons === true
  })

const findSingleAppIconsConstruct = (
  org: Organisation,
): AppIcons | undefined => {
  const appIconsConstructs = findAppIconsConstructs(org)

  if (appIconsConstructs.length > 1) {
    throw new Error("Organisation must declare at most one AppIcons set")
  }

  return appIconsConstructs[0]
}

const resolveAppIconPaths = (
  icon: { readonly source: string; readonly publicPath?: string | undefined },
  basePath?: string | undefined,
): { readonly sourcePath: string; readonly publicPath: string } => {
  const explicitPublicPath =
    icon.publicPath === undefined
      ? undefined
      : ensureAppIconsPublicPath(icon.publicPath)
  const sourcePath = normalizeLocalSourcePath(icon.source, basePath)

  return {
    sourcePath,
    publicPath:
      explicitPublicPath === undefined
        ? generatedPublicPath(sourcePath)
        : explicitPublicPath,
  }
}

export const buildOrganisationFrontendManifestAppIcons = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): OrganisationFrontendManifestAppIcons => {
  const appIcons = findSingleAppIconsConstruct(org)

  if (!appIcons) {
    return { metadata: [], manifest: [] }
  }

  const publicPathSources = new Map<string, string>()
  const addPublicPath = (icon: {
    readonly source: string
    readonly publicPath?: string | undefined
  }): string => {
    const { sourcePath, publicPath } = resolveAppIconPaths(
      icon,
      options?.basePath,
    )
    const existingSourcePath = publicPathSources.get(publicPath)

    if (existingSourcePath !== undefined && existingSourcePath !== sourcePath) {
      throw new Error(`Duplicate AppIcons publicPath: ${publicPath}`)
    }

    publicPathSources.set(publicPath, sourcePath)
    return publicPath
  }

  return {
    metadata: appIcons.metadata.map((icon) => ({
      url: addPublicPath(icon),
      rel: icon.rel ?? "icon",
      type: icon.type ?? inferMimeType(icon.source),
      sizes: icon.sizes,
    })),
    manifest: appIcons.manifest.map((icon) => ({
      src: addPublicPath(icon),
      sizes: icon.sizes,
      type: icon.type ?? inferMimeType(icon.source),
      purpose: icon.purpose,
    })),
  }
}

export const buildOrganisationFrontendManifestAppIconFiles = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): ReadonlyArray<OrganisationFrontendManifestAppIconFile> => {
  const appIcons = findSingleAppIconsConstruct(org)

  if (!appIcons) {
    return []
  }

  const icons = [...appIcons.metadata, ...appIcons.manifest]
  const filesByPublicPath = new Map<
    string,
    OrganisationFrontendManifestAppIconFile
  >()

  for (const icon of icons) {
    const { sourcePath, publicPath } = resolveAppIconPaths(
      icon,
      options?.basePath,
    )
    const existing = filesByPublicPath.get(publicPath)

    if (existing !== undefined) {
      if (existing.sourcePath !== sourcePath) {
        throw new Error(`Duplicate AppIcons publicPath: ${publicPath}`)
      }

      continue
    }

    filesByPublicPath.set(publicPath, {
      sourcePath,
      publicPath,
    })
  }

  return [...filesByPublicPath.values()]
}
