import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { NextResponse } from "next/server"
import {
  getFrontendManifest,
  resolveFrontendManifestPublicFilePath,
} from "@/lib/frontend-manifest-store"

interface PublicFormBrandingRouteParams {
  readonly params: Promise<{ readonly path: ReadonlyArray<string> }>
}

const isContentHashedPath = (publicPath: string): boolean =>
  /-[a-f0-9]{16}\.[^/.]+$/.test(publicPath)

const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
])

const inferContentType = (publicPath: string): string | undefined =>
  MIME_TYPES_BY_EXTENSION.get(extname(publicPath).toLowerCase())

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const brandingHtmlReferencesPublicPath = (
  html: string | undefined,
  publicPath: string,
): boolean =>
  html !== undefined &&
  new RegExp(`${escapeRegExp(publicPath)}(?=["'\\s?#<>]|$)`).test(html)

export const GET = async (
  _request: Request,
  { params }: PublicFormBrandingRouteParams,
) => {
  const { path } = await params
  const publicPath = `/_pf/public-form-branding/${path.join("/")}`
  const manifest = getFrontendManifest()

  if (
    !brandingHtmlReferencesPublicPath(
      manifest.publicFormBranding?.headerHtml,
      publicPath,
    ) &&
    !brandingHtmlReferencesPublicPath(
      manifest.publicFormBranding?.footerHtml,
      publicPath,
    )
  ) {
    return new NextResponse(null, { status: 404 })
  }

  const filePath = resolveFrontendManifestPublicFilePath(publicPath)

  if (!filePath) {
    return new NextResponse(null, { status: 404 })
  }

  try {
    const bytes = await readFile(filePath)
    const headers = new Headers({
      "Cache-Control": isContentHashedPath(publicPath)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    })
    const contentType = inferContentType(publicPath)
    if (contentType) {
      headers.set("Content-Type", contentType)
    }

    return new NextResponse(bytes, {
      headers,
    })
  } catch (error) {
    if (isNotFoundError(error)) {
      return new NextResponse(null, { status: 404 })
    }

    throw error
  }
}
