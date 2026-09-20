import { Data } from "effect"

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
