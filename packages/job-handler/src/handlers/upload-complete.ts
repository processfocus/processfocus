import { SqlClient } from "@effect/sql"
import type { Job } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import { DocumentStoreService } from "@pf/document-store-service"
import {
  CompletedJobOperations,
  FileOperations,
  UPLOAD_COMPLETE_QUEUE,
} from "@pf/graphql-db-operations"

// Re-export for backward compatibility
export { UPLOAD_COMPLETE_QUEUE }

/**
 * Schema for upload-complete queue job payloads.
 */
export const UploadCompletePayloadSchema = Schema.Struct({
  fileId: Schema.String,
  storePrefix: Schema.String,
  fileSize: Schema.Number,
  mimeType: Schema.optional(Schema.String),
})

export type UploadCompletePayload = typeof UploadCompletePayloadSchema.Type

/**
 * Handler for upload-complete queue jobs.
 *
 * This handler is responsible for marking files as uploaded after S3 notifies
 * us that the upload is complete. The S3 event triggers a Lambda which enqueues
 * this job, and the job worker processes it to update the database.
 *
 * Idempotency:
 * - Uses completed_job table to track which jobs have been processed
 * - If job was already completed, skips processing
 *
 * Error handling:
 * - If file doesn't exist, logs warning and marks job complete (don't retry)
 * - If database update fails, transaction rolls back and job retries
 */
const handleUploadComplete = Effect.fn("upload-complete")(
  (job: Job<UploadCompletePayload>) =>
    Effect.gen(function* () {
      const { fileId, storePrefix, fileSize, mimeType } = job.payload
      const completedJobOps = yield* CompletedJobOperations
      const fileOps = yield* FileOperations

      // Idempotency check - if already completed, exit early
      const alreadyCompleted = yield* completedJobOps.isJobCompleted(
        UPLOAD_COMPLETE_QUEUE,
        job.jobId,
      )
      if (alreadyCompleted) {
        yield* Effect.log("Job already completed, skipping", {
          jobId: job.jobId,
          fileId,
        })
        return
      }

      yield* Effect.log("Processing upload-complete job", {
        jobId: job.jobId,
        fileId,
        storePrefix,
        fileSize,
        mimeType,
      })

      const sqlClient = yield* SqlClient.SqlClient

      // Wrap in transaction to ensure atomicity of update + mark complete
      yield* sqlClient.withTransaction(
        Effect.gen(function* () {
          // Check if file record exists (may have been deleted by user)
          const fileRecord = yield* fileOps.getFileWithStore(fileId)
          if (!fileRecord) {
            yield* Effect.log(
              "File record not found, deleting orphaned S3 object",
              { fileId, jobId: job.jobId },
            )
            const docStore = yield* DocumentStoreService
            yield* docStore.deleteFile(fileId, storePrefix).pipe(
              Effect.catchAll((error) =>
                Effect.log("Failed to delete S3 object (best-effort)", {
                  fileId,
                  error: String(error),
                }),
              ),
            )
            yield* completedJobOps.markJobCompleted(
              UPLOAD_COMPLETE_QUEUE,
              job.jobId,
            )
            return
          }

          // Mark file as uploaded with fileSize from S3 and mimeType from S3 content-type
          // mediaKind will be updated if mimeType is provided
          yield* fileOps.markFileUploaded(fileId, fileSize, mimeType)

          yield* Effect.log("File marked as uploaded", {
            fileId,
            fileSize,
            mimeType,
          })

          // Mark job as completed (idempotency marker)
          yield* completedJobOps.markJobCompleted(
            UPLOAD_COMPLETE_QUEUE,
            job.jobId,
          )
        }),
      )
    }),
)

export const uploadCompleteHandler = {
  schema: UploadCompletePayloadSchema,
  handle: handleUploadComplete,
}
