import { NextResponse } from "next/server"
import {
  PublicTodoConfigurationError,
  publicTodoCalendarSlots,
} from "@/lib/public-todo-server"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => null)) as unknown
    if (!isRecord(payload)) {
      return NextResponse.json(
        { error: "Invalid public form calendar slots payload." },
        { status: 400 },
      )
    }

    const { token, field } = payload
    if (typeof token !== "string" || typeof field !== "string") {
      return NextResponse.json(
        { error: "Invalid public form calendar slots payload." },
        { status: 400 },
      )
    }

    const items = await publicTodoCalendarSlots(token, field)
    return NextResponse.json({ items })
  } catch (error) {
    if (error instanceof PublicTodoConfigurationError) {
      return NextResponse.json(
        { error: "Public form service is not configured." },
        { status: 500 },
      )
    }

    console.error("[public-todo] Public calendar slots failed", error)
    return NextResponse.json(
      { error: "Unable to load calendar slots. Please try again." },
      { status: 500 },
    )
  }
}
