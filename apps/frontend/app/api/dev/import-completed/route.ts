import { NextResponse } from "next/server"
import { publishImportCompleted } from "@/lib/dev/import-completed-events"

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as {
    processPaths?: unknown
  } | null
  if (!Array.isArray(body?.processPaths)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const processPaths = body.processPaths.filter(
    (path): path is string => typeof path === "string",
  )
  publishImportCompleted({ processPaths })

  return new Response(null, { status: 204 })
}
