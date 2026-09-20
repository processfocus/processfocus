import { Data } from "effect"

/**
 * Error thrown when organisation fails to load from path.
 */
export class OrgLoadError extends Data.TaggedError("OrgLoadError")<{
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Error thrown when build operations fail.
 */
export class BuildError extends Data.TaggedError("BuildError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when GraphQL schema generation fails.
 */
export class GraphqlSchemaError extends Data.TaggedError("GraphqlSchemaError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when Cedar policy file operations fail.
 */
export class PolicyFileError extends Data.TaggedError("PolicyFileError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when init command fails.
 */
export class InitError extends Data.TaggedError("InitError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

type MigrationErrorArgs = {
  readonly reason: string
  readonly statement?: string | undefined
  readonly cause: unknown
}

/**
 * Error thrown when a database migration fails.
 */
export class MigrationError extends Data.TaggedError("MigrationError")<
  MigrationErrorArgs & {
    readonly message: string
  }
> {
  constructor(args: MigrationErrorArgs) {
    super({
      ...args,
      message: args.statement
        ? `Migration failed: ${args.reason}. Statement: ${args.statement}`
        : `Migration failed: ${args.reason}`,
    })
  }
}

/**
 * Error thrown when auth login times out or fails.
 */
export class AuthLoginError extends Data.TaggedError("AuthLoginError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error thrown when pfcli remote-operation commands fail.
 */
export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
  readonly cause?: unknown
  readonly graphqlErrorCode?: string
  readonly graphqlErrorMessage?: string
}> {}

/**
 * Error thrown when custom-domain command fails.
 */
export class CustomDomainError extends Data.TaggedError("CustomDomainError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
