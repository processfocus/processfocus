/**
 * Encryption service for encrypting and decrypting values.
 * Used for cookie encryption and other secure storage needs.
 * @packageDocumentation
 */
import { Context, Data, Effect, Layer, Schema } from "effect"
import { CompactEncrypt, compactDecrypt } from "jose"
import { StorageError } from "../storage/storage"
import {
  KeyManagementService,
  type NoEncryptionKeysError,
} from "./key-management"

// Re-export for convenience
export type { NoEncryptionKeysError }

/**
 * Error thrown when decryption fails (invalid JWE, wrong key, tampered data, etc.)
 */
export class DecryptionError extends Data.TaggedError(
  "@pf/openauth/DecryptionError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const JsonValue = Schema.fromJsonString(Schema.Unknown)

/**
 * Service interface for encryption operations.
 */
export interface EncryptionServiceInterface {
  /**
   * Encrypt a value using the encryption key.
   * @param value - The value to encrypt (will be JSON serialized)
   * @returns The encrypted JWE string
   */
  readonly encrypt: (
    value: unknown,
  ) => Effect.Effect<string, StorageError | NoEncryptionKeysError>
  /**
   * Decrypt a JWE string using the encryption key.
   * @param value - The JWE string to decrypt
   * @returns The decrypted value (JSON parsed)
   */
  readonly decrypt: (
    value: string,
  ) => Effect.Effect<
    unknown,
    StorageError | NoEncryptionKeysError | DecryptionError
  >
}

/**
 * Effect service tag for encryption operations.
 */
export class EncryptionService extends Context.Service<EncryptionService, EncryptionServiceInterface>()("@pf/openauth/EncryptionService") {}

/**
 * Live implementation of EncryptionService.
 * Uses RSA-OAEP-512 for key encryption and A256GCM for content encryption.
 */
export const EncryptionServiceLive: Layer.Layer<
  EncryptionService,
  never,
  KeyManagementService
> = Layer.effect(
  EncryptionService,
  Effect.gen(function* () {
    const keyMgmt = yield* KeyManagementService

    return {
      encrypt: (value: unknown) =>
        Effect.gen(function* () {
          const key = yield* keyMgmt.encryptionKey
          const encoded = yield* Schema.encodeEffect(JsonValue)(value).pipe(
            Effect.mapError(
              (error) =>
                new StorageError({
                  message: "Failed to encode value for encryption",
                  cause: error,
                }),
            ),
          )
          const encrypted = yield* Effect.promise(() =>
            new CompactEncrypt(
              new TextEncoder().encode(encoded),
            )
              .setProtectedHeader({ alg: "RSA-OAEP-512", enc: "A256GCM" })
              .encrypt(key.public),
          )
          return encrypted
        }),

      decrypt: (value: string) =>
        Effect.gen(function* () {
          const key = yield* keyMgmt.encryptionKey
          // Use tryPromise and map to DecryptionError so callers can handle it
          const result = yield* Effect.tryPromise({
            try: () => compactDecrypt(value, key.private),
            catch: (error) =>
              new DecryptionError({
                message: "Failed to decrypt value",
                cause: error,
              }),
          })
          const decoded = new TextDecoder().decode(result.plaintext)
          return yield* Schema.decodeUnknownEffect(JsonValue)(decoded).pipe(
            Effect.mapError(
              (error) =>
                new DecryptionError({
                  message: "Failed to decode decrypted value",
                  cause: error,
                }),
            ),
          )
        }),
    }
  }),
)
