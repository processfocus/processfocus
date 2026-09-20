import type { SqlError } from "@effect/sql/SqlError"
import { Data } from "effect"

/**
 * Error thrown when attempting to update a deleted process state.
 *
 * This occurs when an update operation targets a process state record
 * that has been soft-deleted (_deleted = true).
 */
export class UpdateDeletedDocumentError extends Data.TaggedError(
  "UpdateDeletedDocumentError",
)<{
  readonly processStateId: string
  readonly message: string
}> {}

/**
 * Error thrown when attempting to query current provider user without an ID in session.
 *
 * This occurs when the session context does not contain a provider user ID,
 * typically indicating the user is not authenticated.
 */
export class NoProviderUserID extends Data.TaggedError("NoProviderUserID")<{
  readonly message: string
}> {}

/**
 * Error thrown when a provider user lookup fails to find a matching record.
 *
 * This occurs when querying for a provider user by ID returns no results,
 * indicating the provider user does not exist in the database.
 */
export class ProviderUserNotFound extends Data.TaggedError(
  "ProviderUserNotFound",
)<{
  readonly userId: string
  readonly message: string
}> {}

/**
 * Error thrown when user is not authorized to perform an action.
 *
 * This occurs when Cedar policy evaluation denies the requested action,
 * typically because the user lacks the required roles.
 */
export class NotAuthorized extends Data.TaggedError("NotAuthorized")<{
  readonly action: string
  readonly resource: string
  readonly message: string
}> {}

/**
 * Error thrown when process state cannot be found for a given todo.
 *
 * This occurs when formMetadata is called with a todoId but the associated
 * process state cannot be retrieved, preventing state-based defaults from
 * being resolved.
 */
export class ProcessStateNotFound extends Data.TaggedError(
  "ProcessStateNotFound",
)<{
  readonly todoId: string
  readonly stepPath: string
  readonly message: string
}> {}

/**
 * Error thrown when a CI remint cannot find a public-completion invitation.
 *
 * This occurs when publicCompletionUrl is queried for a todo with no latest
 * public-completion invitation attempt.
 */
export class PublicCompletionInvitationNotFound extends Data.TaggedError(
  "PublicCompletionInvitationNotFound",
)<{
  readonly todoId: string
  readonly message: string
}> {}

/**
 * Error thrown when the generated GraphQL schema file is missing.
 *
 * This occurs when the dynamic schema loader cannot find the generated
 * schema file at the configured path.
 */
export class MissingGeneratedSchemaError extends Data.TaggedError(
  "MissingGeneratedSchemaError",
)<{
  readonly path: string
}> {}

/**
 * Represents a validation error with field path (dot notation) and message.
 */
export interface ValidationError {
  readonly field: string
  readonly message: string
}

/**
 * Error thrown when input validation fails.
 *
 * Contains an array of field-level validation errors. The message
 * includes the list of invalid fields using dot notation for nested paths.
 */
export class InputValidationError extends Data.TaggedError(
  "InputValidationError",
)<{
  readonly errors: ValidationError[]
}> {
  override get message(): string {
    if (this.errors.length === 1) {
      const error = this.errors[0]
      if (!error) {
        return "Validation failed"
      }
      if (!error.field) {
        return `Validation failed: ${error.message}`
      }
      return `Validation failed for field '${error.field}': ${error.message}`
    }
    const errorDetails = this.errors
      .map((e) => (e.field ? `'${e.field}': ${e.message}` : e.message))
      .join("\n  - ")
    return `Validation failed for fields:\n  - ${errorDetails}`
  }
}

/**
 * Error thrown when a caller reuses an executionId for a different logical start.
 */
export class ExecutionIdConflictError extends Data.TaggedError(
  "ExecutionIdConflictError",
)<{
  readonly executionId: string
}> {
  override get message(): string {
    return `executionId is already used for a different process start: ${this.executionId}`
  }
}

/**
 * Error returned when a step completion keeps conflicting with concurrent work.
 */
export class StepCompletionConflictError extends Data.TaggedError(
  "StepCompletionConflictError",
)<{
  readonly todoId: string
}> {
  override get message(): string {
    return "The process changed while completing this step. Refresh and try again."
  }
}

/**
 * Error thrown when provider user update operation fails.
 *
 * This occurs when validation fails (e.g., invalid email format,
 * empty required fields, or invalid role IDs) or when the
 * provider user cannot be found for the given providerUserId.
 */
export class UpdateProviderUserError extends Data.TaggedError(
  "UpdateProviderUserError",
)<{
  readonly message: string
  readonly providerUserId: string
}> {}

/**
 * Error thrown when a document store cannot be found by path.
 *
 * This occurs when a file upload/download request references a document
 * store path that does not exist in the database.
 */
export class DocumentStoreNotFoundError extends Data.TaggedError(
  "DocumentStoreNotFoundError",
)<{
  readonly path: string
}> {
  override get message(): string {
    return `Document store not found: ${this.path}`
  }
}

/**
 * Error thrown when a list cannot be found by path during export.
 */
export class ListNotFoundError extends Data.TaggedError("ListNotFoundError")<{
  readonly listPath: string
}> {
  override get message(): string {
    return `List not found: ${this.listPath}`
  }
}

/**
 * Error thrown when a CSV export exceeds the maximum allowed rows.
 */
export class ExportRowLimitError extends Data.TaggedError(
  "ExportRowLimitError",
)<{
  readonly listPath: string
  readonly rowCount: number
  readonly maxRows: number
}> {
  override get message(): string {
    return `Export for list "${this.listPath}" matched ${this.rowCount} rows, exceeding the limit of ${this.maxRows}`
  }
}

/**
 * Error thrown when a list export contains non-scalar values that cannot be serialized to CSV.
 */
export class ExportNonScalarError extends Data.TaggedError(
  "ExportNonScalarError",
)<{
  readonly listPath: string
  readonly field: string
  readonly valueType: string
}> {
  override get message(): string {
    return `Export for list "${this.listPath}" contains non-scalar value in field "${this.field}" (type: ${this.valueType}). Only strings, numbers, booleans, and nulls are supported.`
  }
}

/**
 * Error returned when authorized collection paging exceeds its time budget.
 */
export class AuthorizedPageTimeoutError extends Data.TaggedError(
  "AuthorizedPageTimeoutError",
)<{
  readonly message: string
  readonly page: number
  readonly limit: number
}> {}

/**
 * Union type of all errors that can be returned from GraphQL resolvers.
 */
export type GraphqlResolverError =
  | SqlError
  | UpdateDeletedDocumentError
  | NoProviderUserID
  | ProviderUserNotFound
  | NotAuthorized
  | ProcessStateNotFound
  | PublicCompletionInvitationNotFound
  | MissingGeneratedSchemaError
  | InputValidationError
  | ExecutionIdConflictError
  | StepCompletionConflictError
  | UpdateProviderUserError
  | DocumentStoreNotFoundError
  | ListNotFoundError
  | ExportRowLimitError
  | ExportNonScalarError
  | AuthorizedPageTimeoutError
