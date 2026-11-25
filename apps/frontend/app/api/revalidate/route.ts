import { revalidatePath, revalidateTag } from "next/cache"
import { type NextRequest, NextResponse } from "next/server"

/**
 * On-demand revalidation for the local Next.js runtime.
 *
 * Usage:
 *   POST /api/revalidate
 *   Body: { path: "/org-chart", secret: "your-secret" }
 *   Body: { tag: "login-page", secret: "your-secret" }
 *   Body: { path: "/login", tag: "login-page", secret: "your-secret" }
 *
 * REVALIDATE_SECRET must be configured; requests are rejected when it is absent.
 * Hosted OpenNext disables tag/path invalidation and returns 501 after auth.
 */
export const POST = async (request: NextRequest) => {
  try {
    const body = await request.json()
    const { path, tag, secret } = body

    const configuredSecret = process.env["REVALIDATE_SECRET"]
    if (!configuredSecret) {
      return NextResponse.json(
        { message: "Server misconfiguration" },
        { status: 500 },
      )
    }

    if (secret !== configuredSecret) {
      return NextResponse.json({ message: "Invalid secret" }, { status: 401 })
    }

    const hasPath = path && typeof path === "string"
    const hasTag = tag && typeof tag === "string"
    if (!hasPath && !hasTag) {
      return NextResponse.json(
        { message: "Missing path or tag parameter" },
        { status: 400 },
      )
    }

    if (process.env["AWS_LAMBDA_FUNCTION_NAME"]) {
      return NextResponse.json(
        {
          revalidated: false,
          message:
            "On-demand revalidation is unavailable in the hosted runtime",
        },
        { status: 501 },
      )
    }

    // Local Cedar hot reload must expire the old policy on the next request.
    if (hasTag) revalidateTag(tag, { expire: 0 })
    if (hasPath) revalidatePath(path)

    return NextResponse.json({
      revalidated: true,
      ...(hasPath && { path }),
      ...(hasTag && { tag }),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        message: "Error revalidating",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
