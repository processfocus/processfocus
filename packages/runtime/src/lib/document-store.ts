import { Context, Data, type Effect, type Stream } from "effect"

export class DocumentStoreError extends Data.TaggedError("DocumentStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly fileId: string
}> {}

/**
 * Shared document-store contract used by official plugins.
 * The identifier is stable so workspace implementations and published plugins
 * resolve the same Effect service.
 */
export class DocumentStoreService extends Context.Tag(
  "@pf/document-store-service/DocumentStoreService",
)<
  DocumentStoreService,
  {
    readonly requestUploadUrl: (opts: {
      readonly fileId: string
      readonly storePrefix: string
      readonly contentType?: string
      readonly filename?: string
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

    readonly storeFile: (opts: {
      readonly fileId: string
      readonly storePrefix: string
      readonly content: Stream.Stream<Uint8Array, unknown, never>
      readonly contentType: string
      readonly filename?: string
    }) => Effect.Effect<{ fileId: string }, DocumentStoreError>

    readonly getFileContent: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { content: Uint8Array; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    readonly getFileMetadata: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { byteSize: number; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    readonly deleteFile: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<void, DocumentStoreError>
  }
>() {}
