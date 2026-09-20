import { NextResponse } from "next/server"
import {
  PublicTodoConfigurationError,
  requestFreshPublicTodoLink,
} from "@/lib/public-todo-server"

interface PublicTodoFreshLinkBody {
  readonly token?: unknown
}

export const POST = async (request: Request) => {
  const body = (await request
    .json()
    .catch(() => null)) as PublicTodoFreshLinkBody | null
  const token = typeof body?.token === "string" ? body.token : null

  if (!token) {
    return NextResponse.json(
      { error: "Invalid public form fresh-link payload." },
      { status: 400 },
    )
  }

  try {
    const todo = await requestFreshPublicTodoLink(token)
    return NextResponse.json({ todo })
  } catch (error) {
    if (error instanceof PublicTodoConfigurationError) {
      return NextResponse.json(
        { error: "Public form service is not configured." },
        { status: 500 },
      )
    }

    console.error("[public-todo] Fresh-link request failed", error)
    return NextResponse.json(
      { error: "Unable to request a fresh link. Please try again." },
      { status: 500 },
    )
  }
}
