import { readFile } from "node:fs/promises"
import { NextResponse } from "next/server"
import {
  getFrontendManifest,
  resolveFrontendManifestPublicFilePath,
} from "@/lib/frontend-manifest-store"

interface AppIconRouteParams {
  readonly params: Promise<{ readonly path: ReadonlyArray<string> }>
}

const isContentHashedPath = (publicPath: string): boolean =>
  /-[a-f0-9]{16}\.[^/.]+$/.test(publicPath)

const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

export const GET = async (
  _request: Request,
  { params }: AppIconRouteParams,
) => {
  const { path } = await params
  const publicPath = `/_pf/app-icons/${path.join("/")}`
  const manifest = getFrontendManifest()
  const icon = [
    ...manifest.appIcons.metadata.map((entry) => ({
      publicPath: entry.url,
      type: entry.type,
    })),
    ...manifest.appIcons.manifest.map((entry) => ({
      publicPath: entry.src,
      type: entry.type,
    })),
  ].find((entry) => entry.publicPath === publicPath)

  if (!icon) {
    return new NextResponse(null, { status: 404 })
  }

  const filePath = resolveFrontendManifestPublicFilePath(publicPath)

  if (!filePath) {
    return new NextResponse(null, { status: 404 })
  }

  try {
    const bytes = await readFile(filePath)
    return new NextResponse(bytes, {
      headers: {
        "Cache-Control": isContentHashedPath(publicPath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
        ...(icon.type ? { "Content-Type": icon.type } : {}),
      },
    })
  } catch (error) {
    if (isNotFoundError(error)) {
      return new NextResponse(null, { status: 404 })
    }

    throw error
  }
}
