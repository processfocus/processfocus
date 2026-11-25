import { Cause, Option, Predicate, Result } from "effect"
import { GraphQLError } from "graphql"

/** Classify tagged resolver failures and the serialized errors Yoga logs. */
export const isExpectedGraphQLError = (error: unknown): boolean => {
  if (!Predicate.isObject(error)) return false
  const extensions = Predicate.isObject(error["extensions"])
    ? error["extensions"]
    : undefined
  const code = extensions ? extensions["code"] : error["_tag"]
  if (!extensions && typeof code !== "string") return false
  const { http, unexpected } = extensions ?? error
  const status = Predicate.isObject(http) ? http["status"] : undefined
  if (
    unexpected === true ||
    code === "INTERNAL_SERVER_ERROR" ||
    (typeof status === "number" && status >= 500)
  ) {
    return false
  }
  if (typeof status === "number" && status >= 400 && status < 500) return true

  switch (code) {
    case "NotAuthorized":
    case "UNAUTHENTICATED":
    case "BAD_REQUEST":
    case "InputValidationError":
    case "ExecutionIdConflictError":
    case "InvalidRolePreparation":
      return true
    case "ProjectConfigAccessError": {
      // This code also wraps backend failures; only downgrade known client misses.
      const message = error["message"]
      return (
        typeof message === "string" &&
        ((message.startsWith('Project "') &&
          message.endsWith('" was not found.')) ||
          message.startsWith("Stage not found in project: ") ||
          message === "Environment not found.")
      )
    }
    default:
      return false
  }
}

/**
 * Extensions must survive GraphQL Yoga's result serialization; lossy JSON
 * serialization strips prototypes/functions while preserving client-safe data.
 */
export const toSerializableGraphQLExtensions = (
  extensions: Record<string, unknown>,
): Record<string, unknown> => {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(extensions, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null) return value
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return value
  })
  return JSON.parse(json) as Record<string, unknown>
}

/** Extract typed failures and defects while retaining opaque interruption causes. */
export const extractErrorFromCause = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return failure.value
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect) ? defect.success : cause
}

/**
 * Converts an unknown Effect/domain error to a client-safe GraphQLError.
 * SqlError is always redacted so SQL internals never reach the client.
 */
export const toGraphQLError = (error: unknown): GraphQLError => {
  // Never serialize an unextracted cause, which may contain private SQL details.
  if (Cause.isCause(error)) {
    return new GraphQLError("Internal server error", {
      extensions: {
        code: "INTERNAL_ERROR",
      },
    })
  }

  // Redact database errors — never leak SQL, connection strings, or causes.
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "SqlError"
  ) {
    return new GraphQLError("Database operation failed", {
      extensions: {
        code: "DATABASE_ERROR",
      },
    })
  }

  // Preserve InputValidationError field-level details for the client.
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "InputValidationError"
  ) {
    const validationError = error as unknown as {
      message: string
      errors: Array<{ field: string; message: string }>
    }
    return new GraphQLError(validationError.message, {
      extensions: toSerializableGraphQLExtensions({
        code: "InputValidationError",
        errors: validationError.errors,
      }),
    })
  }

  // Other Effect Data.TaggedError (e.g. NotAuthorized)
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as { _tag: string; message?: string }
    return new GraphQLError(tagged.message ?? String(error), {
      extensions: toSerializableGraphQLExtensions({
        code: tagged._tag,
        ...Object.fromEntries(
          Object.entries(error).filter(
            ([k]) => k !== "message" && k !== "_tag",
          ),
        ),
      }),
    })
  }

  if (error && typeof error === "object" && "message" in error) {
    return new GraphQLError(String(error.message))
  }

  return new GraphQLError(String(error))
}
