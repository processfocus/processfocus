import { createHmac } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Context, Effect, Layer, Stream } from "effect"
import {
  DocumentStoreError,
  DocumentStoreService,
  FileNotFoundError,
  sanitizeDownloadFilename,
} from "@pf/document-store-service"

/** 1 hour expiry for presigned URLs */
const URL_EXPIRY_SECONDS = 3600

/**
 * Configuration for the local document store.
 *
 * `baseUrl` is a function because the server port may not be known at
 * config-creation time (e.g. when using port fallback).  The function
 * is called each time a URL is generated.
 */
export class LocalDocumentStoreConfig extends Context.Tag(
  "@pf/runtime-local/LocalDocumentStoreConfig",
)<
  LocalDocumentStoreConfig,
  {
    readonly baseUrl: () => string
    readonly storagePath: string
    readonly secret: string
    /** Maximum allowed file size in bytes. Defaults to 100 MB. */
    readonly maxFileSize: number
  }
>() {}

/**
 * Generate an HMAC-SHA256 token for file URL authentication.
 * Message format: `${storePrefix}/${fileId}:${expires}` when no filename is
 * present, otherwise `${storePrefix}/${fileId}:${expires}:${filename}`.
 */
export const generateLocalDocumentStoreToken = (
  storePrefix: string,
  fileId: string,
  expires: string,
  secret: string,
  filename?: string,
): string => {
  const message = filename
    ? `${storePrefix}/${fileId}:${expires}:${filename}`
    : `${storePrefix}/${fileId}:${expires}`

  return createHmac("sha256", secret).update(message).digest("hex")
}

const ensureDirectory = (
  dir: string,
  failureMessage: string,
): Effect.Effect<void, DocumentStoreError> =>
  Effect.try({
    try: () => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    },
    catch: (cause) =>
      new DocumentStoreError({
        message: `${failureMessage}: ${String(cause)}`,
        cause,
      }),
  })

const pathExists = (
  filePath: string,
  failureMessage: string,
): Effect.Effect<boolean, DocumentStoreError> =>
  Effect.try({
    try: () => existsSync(filePath),
    catch: (cause) =>
      new DocumentStoreError({
        message: `${failureMessage}: ${String(cause)}`,
        cause,
      }),
  })

/**
 * Local filesystem implementation of the DocumentStoreService.
 * Stores files on disk and uses HMAC-signed URLs for authentication.
 */
export const LocalDocumentStoreServiceLive = Layer.effect(
  DocumentStoreService,
  Effect.gen(function* () {
    const config = yield* LocalDocumentStoreConfig

    // Ensure storage directory exists
    if (!existsSync(config.storagePath)) {
      mkdirSync(config.storagePath, { recursive: true })
    }

    return {
      requestUploadUrl: (opts: {
        readonly fileId: string
        readonly storePrefix: string
        readonly contentType?: string
        readonly filename?: string
      }) =>
        Effect.gen(function* () {
          const { fileId, storePrefix } = opts
          const expires = Math.floor(Date.now() / 1000 + URL_EXPIRY_SECONDS)
          const expiresStr = String(expires)
          const token = generateLocalDocumentStoreToken(
            storePrefix,
            fileId,
            expiresStr,
            config.secret,
          )

          // Ensure store subdirectory exists
          const storeDir = join(config.storagePath, storePrefix)
          yield* ensureDirectory(
            storeDir,
            "Failed to ensure upload store directory",
          )

          const uploadUrl = `${config.baseUrl()}/files/${storePrefix}/${fileId}?token=${token}&expires=${expiresStr}`
          const expiresAt = new Date(expires * 1000).toISOString()

          yield* Effect.log("Generated upload URL").pipe(
            Effect.annotateLogs({
              fileId,
              storePrefix,
              contentType: opts.contentType,
            }),
          )

          return { fileId, uploadUrl, expiresAt }
        }),

      requestDownloadUrl: (
        fileId: string,
        storePrefix: string,
        filename?: string,
      ) =>
        Effect.gen(function* () {
          // Check file exists
          const filePath = join(config.storagePath, storePrefix, fileId)
          const exists = yield* pathExists(
            filePath,
            "Failed to check file existence for download URL",
          )
          if (!exists) {
            return yield* new FileNotFoundError({ fileId })
          }

          const signedFilename = filename
            ? sanitizeDownloadFilename(filename)
            : undefined

          const expires = Math.floor(Date.now() / 1000 + URL_EXPIRY_SECONDS)
          const expiresStr = String(expires)
          const token = generateLocalDocumentStoreToken(
            storePrefix,
            fileId,
            expiresStr,
            config.secret,
            signedFilename,
          )

          let downloadUrl = `${config.baseUrl()}/files/${storePrefix}/${fileId}?token=${token}&expires=${expiresStr}`
          if (signedFilename) {
            downloadUrl += `&filename=${encodeURIComponent(signedFilename)}`
          }
          const expiresAt = new Date(expires * 1000).toISOString()

          yield* Effect.log("Generated download URL").pipe(
            Effect.annotateLogs({ fileId, storePrefix }),
          )

          return { downloadUrl, expiresAt }
        }),

      storeFile: (opts: {
        readonly fileId: string
        readonly storePrefix: string
        readonly content: Stream.Stream<Uint8Array, unknown, never>
        readonly contentType: string
        readonly filename?: string
      }) =>
        Effect.gen(function* () {
          const { fileId, storePrefix } = opts

          // Ensure store subdirectory exists
          const storeDir = join(config.storagePath, storePrefix)
          yield* ensureDirectory(
            storeDir,
            "Failed to ensure store directory for write",
          )

          // Collect stream into a single Uint8Array.
          // Stream.runFold is a terminal operation that fully consumes the
          // stream and runs all finalizers on completion, error, or
          // interruption — no explicit cleanup needed.
          const parts = yield* Stream.runFold(
            opts.content,
            [] as Uint8Array[],
            (acc, chunk) => {
              acc.push(chunk)
              return acc
            },
          ).pipe(
            Effect.mapError(
              (error) =>
                new DocumentStoreError({
                  message: `Failed to collect stream: ${String(error)}`,
                  cause: error,
                }),
            ),
          )
          const totalLength = parts.reduce((sum, arr) => sum + arr.length, 0)
          const body = new Uint8Array(totalLength)
          let offset = 0
          for (const arr of parts) {
            body.set(arr, offset)
            offset += arr.length
          }

          const filePath = join(storeDir, fileId)
          yield* Effect.try({
            try: () => {
              writeFileSync(filePath, body)
            },
            catch: (cause) =>
              new DocumentStoreError({
                message: `Failed to store file: ${String(cause)}`,
                cause,
              }),
          })

          yield* Effect.log("Stored file locally").pipe(
            Effect.annotateLogs({
              fileId,
              storePrefix,
              path: filePath,
              contentType: opts.contentType,
            }),
          )

          return { fileId }
        }),

      getFileContent: (fileId: string, storePrefix: string) =>
        Effect.gen(function* () {
          const filePath = join(config.storagePath, storePrefix, fileId)
          const exists = yield* pathExists(
            filePath,
            "Failed to check file existence for read",
          )
          if (!exists) {
            return yield* new FileNotFoundError({ fileId })
          }

          const content = yield* Effect.try({
            try: () => readFileSync(filePath),
            catch: (cause) => {
              const nodeError = cause as NodeJS.ErrnoException
              if (nodeError.code === "ENOENT") {
                return new FileNotFoundError({ fileId })
              }
              return new DocumentStoreError({
                message: `Failed to read file: ${String(cause)}`,
                cause,
              })
            },
          })

          yield* Effect.log("Retrieved file content locally").pipe(
            Effect.annotateLogs({ fileId, storePrefix, path: filePath }),
          )

          return {
            content: new Uint8Array(content),
            contentType: "application/octet-stream",
          }
        }),

      getFileMetadata: (fileId: string, storePrefix: string) =>
        Effect.gen(function* () {
          const filePath = join(config.storagePath, storePrefix, fileId)
          const metadata = yield* Effect.try({
            try: () => statSync(filePath),
            catch: (cause) => {
              const nodeError = cause as NodeJS.ErrnoException
              if (nodeError.code === "ENOENT") {
                return new FileNotFoundError({ fileId })
              }
              return new DocumentStoreError({
                message: `Failed to stat file: ${String(cause)}`,
                cause,
              })
            },
          })

          return {
            byteSize: metadata.size,
            contentType: "application/octet-stream",
          }
        }),

      deleteFile: (fileId: string, storePrefix: string) =>
        Effect.gen(function* () {
          const filePath = join(config.storagePath, storePrefix, fileId)
          yield* Effect.try({
            try: () => unlinkSync(filePath),
            catch: (error): DocumentStoreError =>
              new DocumentStoreError({
                message: `Failed to delete file: ${String(error)}`,
                cause: error,
              }),
          }).pipe(
            Effect.catchAll((error: DocumentStoreError) => {
              const nodeError = error.cause as NodeJS.ErrnoException
              if (nodeError.code === "ENOENT") return Effect.void
              return Effect.fail(error)
            }),
          )
          yield* Effect.log("Deleted local file").pipe(
            Effect.annotateLogs({ fileId, storePrefix, path: filePath }),
          )
        }),
    }
  }),
)
