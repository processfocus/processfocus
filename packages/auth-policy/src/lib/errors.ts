import { Data } from "effect"

/**
 * Failed to load policies file
 */
export class PolicyLoadError extends Data.TaggedError("PolicyLoadError")<{
  readonly path: string
  readonly cause?: unknown
}> {}

/**
 * Failed to load schema file
 */
export class SchemaLoadError extends Data.TaggedError("SchemaLoadError")<{
  readonly path: string
  readonly cause?: unknown
}> {}

/**
 * Failed to parse Cedar policies
 */
export class PolicyParseError extends Data.TaggedError("PolicyParseError")<{
  readonly errors: string[]
}> {}

/**
 * Failed to parse Cedar schema
 */
export class SchemaParseError extends Data.TaggedError("SchemaParseError")<{
  readonly errors: string[]
}> {}

/**
 * Error during authorization evaluation
 */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly message: string
}> {}

/**
 * Authorization was denied by policy
 */
export class AuthorizationDeniedError extends Data.TaggedError(
  "AuthorizationDeniedError",
)<{
  readonly reason: string
}> {}
