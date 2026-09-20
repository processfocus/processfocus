import { Cause, Option, Runtime } from "effect"
import { GraphQLError } from "graphql"

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

/**
 * Extract the actual error from an Effect FiberFailure.
 * Effect wraps errors in FiberFailure when runPromise rejects.
 * Uses Runtime.isFiberFailure / FiberFailureCauseId (stable API) rather than
 * constructor-name sniffing, which can fail under minification or Effect upgrades.
 */
export const extractErrorFromFiberFailure = (
  fiberFailure: unknown,
): unknown => {
  if (!Runtime.isFiberFailure(fiberFailure)) {
    return fiberFailure
  }

  const cause = fiberFailure[Runtime.FiberFailureCauseId]
  // Prefer typed failures (Effect.fail), then defects (Effect.die).
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  if (failure !== undefined) {
    return failure
  }
  const defect = Option.getOrUndefined(Cause.dieOption(cause))
  if (defect !== undefined) {
    return defect
  }

  // Empty / unextractable cause: leave FiberFailure for toGraphQLError to treat
  // as opaque so pretty-printed SQL never reaches the client via .message.
  return fiberFailure
}

/**
 * Converts an unknown Effect/domain error to a client-safe GraphQLError.
 * SqlError is always redacted so SQL internals never reach the client.
 */
export const toGraphQLError = (error: unknown): GraphQLError => {
  // FiberFailure messages embed Cause.pretty output (often SQL). Never forward.
  if (Runtime.isFiberFailure(error)) {
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
