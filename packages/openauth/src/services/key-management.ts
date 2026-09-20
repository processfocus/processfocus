/**
 * Key management service for cryptographic operations.
 * Provides access to signing and encryption keys.
 * @packageDocumentation
 */
import { Context, Data, Effect, Layer } from "effect"
import {
  type KeyPair,
  encryptionKeys,
  legacySigningKeys,
  signingKeys,
} from "../keys"
import { type StorageError, StorageService } from "../storage/storage"

/**
 * Error thrown when no signing keys are available.
 */
export class NoSigningKeysError extends Data.TaggedError(
  "@pf/NoSigningKeysError",
)<{
  readonly message: string
}> {}

/**
 * Error thrown when no encryption keys are available.
 */
export class NoEncryptionKeysError extends Data.TaggedError(
  "@pf/NoEncryptionKeysError",
)<{
  readonly message: string
}> {}

/**
 * Service interface for key management operations.
 */
export interface KeyManagementServiceInterface {
  /**
   * Get all signing keys (including legacy keys).
   * Keys are sorted by creation date (newest first).
   */
  readonly allSigningKeys: Effect.Effect<readonly KeyPair[], StorageError>
  /**
   * Get the current signing key (first non-expired key).
   */
  readonly signingKey: Effect.Effect<KeyPair, StorageError | NoSigningKeysError>
  /**
   * Get the current encryption key (first non-expired key).
   */
  readonly encryptionKey: Effect.Effect<
    KeyPair,
    StorageError | NoEncryptionKeysError
  >
}

/**
 * Effect service tag for key management.
 */
export class KeyManagementService extends Context.Tag(
  "@pf/openauth/KeyManagementService",
)<KeyManagementService, KeyManagementServiceInterface>() {}

/**
 * Live implementation of KeyManagementService.
 * Loads keys lazily and caches them for the lifetime of the service.
 * Uses Effect.cached to ensure keys are only loaded once (race-condition safe).
 */
export const KeyManagementServiceLive: Layer.Layer<
  KeyManagementService,
  never,
  StorageService
> = Layer.effect(
  KeyManagementService,
  Effect.gen(function* () {
    // Get storage service implementation from context
    const storageImpl = yield* StorageService
    const storageLayer = Layer.succeed(StorageService, storageImpl)

    // Create memoized effects for key loading using Effect.cached
    // This ensures each loading effect runs at most once, even under concurrent access
    const loadSigningKeys = yield* Effect.cached(
      Effect.gen(function* () {
        const [signing, legacy] = yield* Effect.all([
          signingKeys,
          legacySigningKeys,
        ]).pipe(Effect.provide(storageLayer))
        return [...signing, ...legacy] as readonly KeyPair[]
      }),
    )

    const loadEncryptionKeys = yield* Effect.cached(
      encryptionKeys.pipe(Effect.provide(storageLayer)),
    )

    return {
      allSigningKeys: loadSigningKeys,
      signingKey: Effect.gen(function* () {
        const all = yield* loadSigningKeys
        const key = all[0]
        if (!key) {
          return yield* new NoSigningKeysError({
            message: "No signing keys available",
          })
        }
        return key
      }),
      encryptionKey: Effect.gen(function* () {
        const all = yield* loadEncryptionKeys
        const key = all[0]
        if (!key) {
          return yield* new NoEncryptionKeysError({
            message: "No encryption keys available",
          })
        }
        return key
      }),
    }
  }),
)
