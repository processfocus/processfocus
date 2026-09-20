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

export const PUBLIC_FORM_BRANDING_PUBLIC_PATH_PREFIX =
  "/_pf/public-form-branding/"

class PublicFormBrandingSourceError extends Error {}

export interface PublicFormBrandingProps {
  readonly headerHtml?: string | undefined
  readonly footerHtml?: string | undefined
}

export interface OrganisationFrontendManifestPublicFormBranding {
  readonly headerHtml?: string | undefined
  readonly footerHtml?: string | undefined
}

export interface OrganisationFrontendManifestPublicFormBrandingFile {
  readonly sourcePath: string
  readonly publicPath: string
}

export class PublicFormBranding extends Construct {
  readonly isPublicFormBranding = true as const
  readonly headerHtml: string | undefined
  readonly footerHtml: string | undefined

  constructor(scope: IConstruct, id: string, props: PublicFormBrandingProps) {
    super(scope, id)

    const headerHtml = normalizeSnippet(props.headerHtml)
    const footerHtml = normalizeSnippet(props.footerHtml)

    if (headerHtml === undefined && footerHtml === undefined) {
      throw new Error(
        `PublicFormBranding "${id}" must declare headerHtml or footerHtml`,
      )
    }

    this.headerHtml = headerHtml
    this.footerHtml = footerHtml
  }
}

const normalizeSnippet = (html: string | undefined): string | undefined => {
  if (html === undefined || html.trim().length === 0) {
    return undefined
  }

  return html
}

const resolveExistingBasePath = (rootPath: string): string => {
  try {
    return realpathSync(rootPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new PublicFormBrandingSourceError(
        `PublicFormBranding base path not found: ${rootPath}`,
        { cause: error },
      )
    }

    throw error
  }
}

const normalizeLocalSourcePath = (
  source: string,
  basePath?: string,
): string => {
  if (source.trim().length === 0) {
    throw new PublicFormBrandingSourceError(
      "PublicFormBranding source must be a non-empty string",
    )
  }

  if (isAbsolute(source)) {
    throw new PublicFormBrandingSourceError(
      "PublicFormBranding source must be a relative org-local file",
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
    throw new PublicFormBrandingSourceError(
      "PublicFormBranding source must be a relative org-local file",
    )
  }

  try {
    const rootRealPath = resolveExistingBasePath(rootPath)
    const stats = statSync(sourcePath)
    if (!stats.isFile()) {
      throw new PublicFormBrandingSourceError(
        `PublicFormBranding source must be a file: ${source}`,
      )
    }

    const realSourcePath = realpathSync(sourcePath)
    const relativeRealSourcePath = relative(rootRealPath, realSourcePath)

    if (
      relativeRealSourcePath.length === 0 ||
      relativeRealSourcePath === ".." ||
      relativeRealSourcePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeRealSourcePath)
    ) {
      throw new PublicFormBrandingSourceError(
        "PublicFormBranding source must be a relative org-local file",
      )
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new PublicFormBrandingSourceError(
        `PublicFormBranding source file not found: ${source}`,
        { cause: error },
      )
    }

    if (error instanceof PublicFormBrandingSourceError) {
      throw error
    }

    throw new Error(
      `Failed to inspect PublicFormBranding source file: ${source}`,
      {
        cause: error,
      },
    )
  }

  return sourcePath
}

const generatedPublicPath = (sourcePath: string): string => {
  const contents = readFileSync(sourcePath)
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16)
  const extension = extname(sourcePath)
  const name = basename(sourcePath, extension)

  return `${PUBLIC_FORM_BRANDING_PUBLIC_PATH_PREFIX}${name}-${hash}${extension}`
}

const findPublicFormBrandingConstructs = (
  org: Organisation,
): ReadonlyArray<PublicFormBranding> =>
  org.node.findAll().filter((construct): construct is PublicFormBranding => {
    const casted = construct as { readonly isPublicFormBranding?: unknown }
    return casted.isPublicFormBranding === true
  })

const findSinglePublicFormBrandingConstruct = (
  org: Organisation,
): PublicFormBranding | undefined => {
  const brandingConstructs = findPublicFormBrandingConstructs(org)

  if (brandingConstructs.length > 1) {
    throw new Error("Organisation must declare at most one PublicFormBranding")
  }

  return brandingConstructs[0]
}

const isRelativeAssetUrl = (value: string): boolean => {
  const trimmed = value.trim()

  return !(
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  )
}

const splitUrlDecoration = (
  value: string,
): { readonly path: string; readonly decoration: string } => {
  const decorationIndex = value.search(/[?#]/)

  if (decorationIndex === -1) {
    return { path: value, decoration: "" }
  }

  return {
    path: value.slice(0, decorationIndex),
    decoration: value.slice(decorationIndex),
  }
}

const rewriteHtmlAssetUrls = (
  html: string,
  addAsset: (source: string) => string,
): string =>
  html.replace(
    /\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (
      match,
      attribute: string,
      rawValue: string,
      doubleQuoted?: string,
      singleQuoted?: string,
      unquoted?: string,
    ) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? ""

      if (!isRelativeAssetUrl(value)) {
        return match
      }

      const { path, decoration } = splitUrlDecoration(value)
      const publicPath = `${addAsset(path)}${decoration}`

      if (rawValue.startsWith('"')) {
        return `${attribute}="${publicPath}"`
      }

      if (rawValue.startsWith("'")) {
        return `${attribute}='${publicPath}'`
      }

      return `${attribute}=${publicPath}`
    },
  )

const buildPublicFormBranding = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): {
  readonly branding: OrganisationFrontendManifestPublicFormBranding | null
  readonly files: ReadonlyArray<OrganisationFrontendManifestPublicFormBrandingFile>
} => {
  const branding = findSinglePublicFormBrandingConstruct(org)

  if (!branding) {
    return { branding: null, files: [] }
  }

  const filesBySourcePath = new Map<
    string,
    OrganisationFrontendManifestPublicFormBrandingFile
  >()
  const addAsset = (source: string): string => {
    const sourcePath = normalizeLocalSourcePath(source, options?.basePath)
    const existing = filesBySourcePath.get(sourcePath)

    if (existing !== undefined) {
      return existing.publicPath
    }

    const publicPath = generatedPublicPath(sourcePath)
    const file = { sourcePath, publicPath }
    filesBySourcePath.set(sourcePath, file)
    return publicPath
  }

  return {
    branding: {
      ...(branding.headerHtml !== undefined
        ? { headerHtml: rewriteHtmlAssetUrls(branding.headerHtml, addAsset) }
        : {}),
      ...(branding.footerHtml !== undefined
        ? { footerHtml: rewriteHtmlAssetUrls(branding.footerHtml, addAsset) }
        : {}),
    },
    files: [...filesBySourcePath.values()],
  }
}

export const buildOrganisationFrontendManifestPublicFormBranding = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): OrganisationFrontendManifestPublicFormBranding | null =>
  buildPublicFormBranding(org, options).branding

export const buildOrganisationFrontendManifestPublicFormBrandingFiles = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): ReadonlyArray<OrganisationFrontendManifestPublicFormBrandingFile> =>
  buildPublicFormBranding(org, options).files
