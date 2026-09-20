import { ClientError } from "graphql-request"
import { type NextRequest, NextResponse } from "next/server"
import { getFrontendJwt } from "@pf/auth-session"
import type { FieldError } from "@pf/form"
import { getEmbedManifestEntry } from "@/lib/embed-manifest-store"
import { isAllowedEmbedOrigin } from "@/lib/embed-request-origin"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

interface SubmitEmbedBody {
  readonly stepPath?: unknown
  readonly values?: unknown
}

interface ValidationError {
  readonly field: string
  readonly message: string
}

export const POST = async (request: NextRequest) => {
  const body = (await request
    .json()
    .catch(() => null)) as SubmitEmbedBody | null
  const stepPath = typeof body?.stepPath === "string" ? body.stepPath : null
  const values =
    body?.values &&
    typeof body.values === "object" &&
    !Array.isArray(body.values)
      ? (body.values as Record<string, unknown>)
      : null

  if (!stepPath || values === null) {
    return NextResponse.json(
      { error: "Invalid embed submission payload." },
      { status: 400 },
    )
  }

  const entry = getEmbedManifestEntry(stepPath)
  if (!entry) {
    return NextResponse.json(
      { error: "Embedded form not found." },
      { status: 404 },
    )
  }

  if (
    !isAllowedEmbedOrigin(request.headers, entry.sites, request.nextUrl.origin)
  ) {
    return NextResponse.json(
      { error: "Embed submission origin is not allowed." },
      { status: 403 },
    )
  }

  const frontendJwt = getFrontendJwt()
  if (!frontendJwt) {
    return NextResponse.json(
      { error: "FRONTEND_JWT_TOKEN is not configured." },
      { status: 500 },
    )
  }

  const client = createServerGraphqlClient(frontendJwt)
  const hasInput =
    entry.inputTypeName.length > 0 && Object.keys(values).length > 0
  const mutation = hasInput
    ? `
      mutation SubmitEmbeddedForm($input: ${entry.inputTypeName}!) {
        ${entry.mutationName}(input: $input) {
          executionId
        }
      }
    `
    : `
      mutation SubmitEmbeddedForm {
        ${entry.mutationName} {
          executionId
        }
      }
    `

  try {
    await client.request(mutation, hasInput ? { input: values } : undefined)
    return NextResponse.json({ submitted: true })
  } catch (error) {
    if (error instanceof ClientError) {
      const gqlError = error.response.errors?.[0]
      if (gqlError?.extensions?.["code"] === "InputValidationError") {
        const errors = gqlError.extensions["errors"] as
          | ValidationError[]
          | undefined

        return NextResponse.json(
          { errors: (errors ?? []) satisfies FieldError[] },
          { status: 400 },
        )
      }

      return NextResponse.json(
        {
          error:
            gqlError?.message ?? "Unable to submit the form. Please try again.",
        },
        { status: 400 },
      )
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected embed submission error.",
      },
      { status: 500 },
    )
  }
}
