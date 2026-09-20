import { NextResponse } from "next/server"
import {
  PublicTodoConfigurationError,
  publicTodoLookupSuggestions,
} from "@/lib/public-todo-server"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => null)) as unknown
    if (!isRecord(payload)) {
      return NextResponse.json(
        { error: "Invalid public form lookup payload." },
        { status: 400 },
      )
    }

    const { token, field, filter, limit } = payload
    if (
      typeof token !== "string" ||
      typeof field !== "string" ||
      (filter !== undefined && filter !== null && typeof filter !== "string") ||
      (limit !== undefined &&
        limit !== null &&
        (typeof limit !== "number" ||
          !Number.isFinite(limit) ||
          !Number.isInteger(limit) ||
          limit < 0 ||
          limit > 100))
    ) {
      return NextResponse.json(
        { error: "Invalid public form lookup payload." },
        { status: 400 },
      )
    }

    const items = await publicTodoLookupSuggestions(
      token,
      field,
      filter ?? null,
      limit ?? null,
    )

    return NextResponse.json({ items })
  } catch (error) {
    if (error instanceof PublicTodoConfigurationError) {
      return NextResponse.json(
        { error: "Public form service is not configured." },
        { status: 500 },
      )
    }

    console.error("[public-todo] Public lookup failed", error)
    return NextResponse.json(
      { error: "Unable to load lookup suggestions. Please try again." },
      { status: 500 },
    )
  }
}
