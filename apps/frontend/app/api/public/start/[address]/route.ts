import { NextResponse } from "next/server"
import {
  lookupAnonymousPage,
  submitAnonymousPage,
} from "@/lib/anonymous-page-server"
import { publicTodoFieldErrorsFromGraphqlError } from "@/lib/public-todo-server"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export async function POST(
  request: Request,
  context: { params: Promise<{ address: string }> },
): Promise<Response> {
  const { address } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (!isRecord(body))
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  try {
    if (body["action"] === "lookup" && typeof body["field"] === "string") {
      const items = await lookupAnonymousPage({
        address,
        field: body["field"],
        ...(typeof body["selectedValue"] === "string" && {
          selectedValue: body["selectedValue"],
        }),
        filter: typeof body["filter"] === "string" ? body["filter"] : "",
        limit:
          typeof body["limit"] === "number" && Number.isFinite(body["limit"])
            ? Math.trunc(body["limit"])
            : 20,
      })
      return NextResponse.json({ items })
    }
    if (body["action"] === "submit" && isRecord(body["values"])) {
      await submitAnonymousPage(address, body["values"])
      return NextResponse.json({ submitted: true })
    }
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  } catch (error) {
    const errors = publicTodoFieldErrorsFromGraphqlError(error)
    return NextResponse.json(
      errors
        ? { errors }
        : { error: "Unable to use this form. Please try again." },
      { status: 400 },
    )
  }
}
