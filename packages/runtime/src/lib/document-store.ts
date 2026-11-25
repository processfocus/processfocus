import { Context, Data, type Effect, type Stream } from "effect"

export class DocumentStoreError extends Data.TaggedError("DocumentStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly fileId: string
}> {}

/**
 * Canonical document-store contract used by runtime adapters and plugins.
 * The identifier is stable so workspace implementations and published plugins
 * resolve the same Effect service.
 */
export class DocumentStoreService extends Context.Service<
  DocumentStoreService,
  {
    readonly requestUploadUrl: (opts: {
      readonly fileId: string
      readonly storePrefix: string
      readonly contentType?: string
      readonly filename?: string
      /** Absolute upper bound for caller-derived upload capability (epoch ms). */
      readonly expiresAt?: number
    }) => Effect.Effect<
      { fileId: string; uploadUrl: string; expiresAt: string },
      DocumentStoreError
    >

    readonly requestDownloadUrl: (
      fileId: string,
      storePrefix: string,
      filename?: string,
    ) => Effect.Effect<
      { downloadUrl: string; expiresAt: string },
      DocumentStoreError | FileNotFoundError
    >

    /** Store a byte stream directly from a trusted server-side workflow. */
    readonly storeFile: (opts: {
      readonly fileId: string
      readonly storePrefix: string
      readonly content: Stream.Stream<Uint8Array, unknown, never>
      readonly contentType: string
      readonly filename?: string
    }) => Effect.Effect<{ fileId: string }, DocumentStoreError>

    /** Read bytes for email attachments or other server-side processing. */
    readonly getFileContent: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { content: Uint8Array; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    /** Inspect size and content type without buffering the file body. */
    readonly getFileMetadata: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { byteSize: number; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    /** Clean up orphaned or cancelled uploads. */
    readonly deleteFile: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<void, DocumentStoreError>
  }
>()("@pf/document-store-service/DocumentStoreService") {}
