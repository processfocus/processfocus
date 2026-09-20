import { Data } from "effect"

/**
 * Error thrown when an internal invariant is violated.
 */
export class InvariantViolationError extends Data.TaggedError(
  "InvariantViolationError",
)<{
  readonly message: string
}> {}
