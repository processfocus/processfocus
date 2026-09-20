import { ClientError } from "graphql-request"

export function getDisplayErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ClientError) {
    const gqlError = error.response.errors?.[0]
    const code = gqlError?.extensions?.["code"]

    if (code === "NotAuthorized") {
      return "You do not have permission to access this form."
    }

    console.error("GraphQL error shown with fallback message", {
      code,
      message: gqlError?.message,
    })
  }

  return fallback
}
