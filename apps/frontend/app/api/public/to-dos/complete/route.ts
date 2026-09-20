import { NextResponse } from "next/server"
import type { FieldError } from "@pf/form"
import {
  PublicTodoConfigurationError,
  completePublicTodo,
  publicTodoFieldErrorsFromGraphqlError,
} from "@/lib/public-todo-server"

interface PublicTodoCompleteBody {
  readonly token?: unknown
  readonly values?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const POST = async (request: Request) => {
  const body = (await request
    .json()
    .catch(() => null)) as PublicTodoCompleteBody | null
  const token = typeof body?.token === "string" ? body.token : null
  const values = isRecord(body?.values) ? body.values : null

  if (!token || values === null) {
    return NextResponse.json(
      { error: "Invalid public form submission payload." },
      { status: 400 },
    )
  }

  try {
    const todo = await completePublicTodo(token, values)
    return NextResponse.json({ todo })
  } catch (error) {
    if (error instanceof PublicTodoConfigurationError) {
      return NextResponse.json(
        { error: "Public form service is not configured." },
        { status: 500 },
      )
    }

    const fieldErrors = publicTodoFieldErrorsFromGraphqlError(error)
    if (fieldErrors) {
      return NextResponse.json(
        { errors: fieldErrors satisfies FieldError[] },
        { status: 400 },
      )
    }

    console.error("[public-todo] Public completion failed", error)
    return NextResponse.json(
      { error: "Unable to submit this form. Please try again." },
      { status: 500 },
    )
  }
}
