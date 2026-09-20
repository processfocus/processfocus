import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"

/**
 * Service providing database operations for file tracking.
 *
 * Creates file records in the database, validates uploads,
 * and marks files as uploaded after successful transfer.
 */
export class FileOperations extends Context.Tag(
  "@pf/graphql-db-operations/FileOperations",
)<
  FileOperations,
  {
    /**
     * Create a new file record linked to a document store.
     * The file starts with upload_pending=true.
     * @param documentStoreId The document store to associate with
     * @param mimeType Optional MIME type for the file
     * @param createdBy Provider user ID of the uploader
     * @returns The database-generated file ID
     */
    readonly createFile: (
      documentStoreId: string,
      mimeType?: string,
      createdBy?: string,
    ) => Effect.Effect<string, SqlError, RequestTime>

    /**
     * Get a file record with its associated document store info.
     * Returns null if the file does not exist.
     */
    readonly getFileWithStore: (fileId: string) => Effect.Effect<
      {
        id: string
        documentStoreId: string
        fileSize: number | null
        uploadPending: boolean
        storeName: string
        acceptedTypes: readonly string[] | null
        sizeLimit: number | null
      } | null,
      SqlError
    >

    /**
     * Mark a file as uploaded (upload_pending=false) and optionally set its size and type.
     * The fileSize and mimeType are optional - if not provided, only upload_pending is updated.
     * This is used when S3 notifies us of upload completion (size from S3 event, mimeType already set).
     */
    readonly markFileUploaded: (
      fileId: string,
      fileSize?: number,
      mimeType?: string,
    ) => Effect.Effect<void, SqlError, RequestTime>

    /**
     * Look up a document store by its path.
     * Returns null if the store does not exist.
     */
    readonly getDocumentStoreByPath: (
      path: string,
    ) => Effect.Effect<{ id: string; name: string } | null, SqlError>

    /**
     * Check if a step is linked to a document store via the junction table.
     * Used for authorization to verify the step can access this document store.
     */
    readonly isStepLinkedToDocumentStore: (
      stepPath: string,
      documentStorePath: string,
    ) => Effect.Effect<boolean, SqlError>

    /**
     * Get file owner, org unit, and document store information for authorization.
     * Joins file -> document_store -> org_unit to get the owner, org unit path,
     * and document store path.
     * Returns null if the file does not exist.
     */
    readonly getFileOwnerInfo: (fileId: string) => Effect.Effect<
      {
        createdBy: string
        orgUnitPath: string
        documentStorePath: string
      } | null,
      SqlError
    >

    /**
     * Delete a file record from the database.
     * Returns true if a row was deleted, false if the file didn't exist.
     * This is a hard delete (not soft delete) for cancelled uploads.
     */
    readonly deleteFile: (fileId: string) => Effect.Effect<boolean, SqlError>
  }
>() {}
