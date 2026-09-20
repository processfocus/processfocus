import { Context, type Effect, type Stream } from "effect"
import type { DocumentStoreError, FileNotFoundError } from "./errors.js"

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

    /**
     * Store a file directly from a stream of bytes.
     * Used by trusted server-side workflows to write content into the document
     * store without going through presigned URLs.
     */
    readonly storeFile: (opts: {
      readonly fileId: string
      readonly storePrefix: string
      readonly content: Stream.Stream<Uint8Array, unknown, never>
      readonly contentType: string
      readonly filename?: string
    }) => Effect.Effect<{ fileId: string }, DocumentStoreError>

    /**
     * Retrieve file content as a byte array.
     * Used for embedding files in emails (base64 encoding) or other
     * server-side processing that needs raw bytes.
     */
    readonly getFileContent: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { content: Uint8Array; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    /**
     * Retrieve file metadata without reading the full file body.
     * Used to enforce server-side size caps before buffering object content.
     */
    readonly getFileMetadata: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<
      { byteSize: number; contentType: string },
      DocumentStoreError | FileNotFoundError
    >

    /**
     * Delete a file from the document store.
     * Used for cleaning up orphaned or cancelled uploads.
     */
    readonly deleteFile: (
      fileId: string,
      storePrefix: string,
    ) => Effect.Effect<void, DocumentStoreError>
  }
>() {}
