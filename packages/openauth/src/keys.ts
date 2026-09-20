import { Effect, Stream } from "effect"
import type { JWK } from "jose"
import {
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
} from "jose"
import { Storage, StorageError, type StorageService } from "./storage/storage"

const signingAlg = "ES256"
const encryptionAlg = "RSA-OAEP-512"

/**
 * Key material that can be used for cryptographic operations.
 * Compatible with jose v6+ which removed the KeyLike export.
 */
export type KeyLike = Awaited<ReturnType<typeof importSPKI>> | Uint8Array

interface SerializedKeyPair {
  id: string
  publicKey: string
  privateKey: string
  created: number
  alg: string
  expired?: number
}

export interface KeyPair {
  id: string
  alg: string
  public: KeyLike
  private: KeyLike
  created: Date
  expired?: Date
  jwk: JWK
}

/**
 * Get legacy signing keys (RS512) for backward compatibility.
 * These are marked as expired to encourage migration to new keys.
 */
export const legacySigningKeys: Effect.Effect<KeyPair[], StorageError, StorageService> =
  Effect.gen(function* () {
    const alg = "RS512"
    const results: KeyPair[] = []

    const mapKeyError = (error: unknown) =>
      new StorageError({ message: "Failed to import key", cause: error })

    yield* Storage.scan<SerializedKeyPair>(["oauth:key"]).pipe(
      Stream.runForEach(([_key, value]) =>
        Effect.gen(function* () {
          const publicKey = yield* Effect.tryPromise({
            try: () => importSPKI(value.publicKey, alg, { extractable: true }),
            catch: mapKeyError,
          })
          const privateKey = yield* Effect.tryPromise({
            try: () => importPKCS8(value.privateKey, alg),
            catch: mapKeyError,
          })
          const jwk = yield* Effect.tryPromise({
            try: () => exportJWK(publicKey),
            catch: mapKeyError,
          })
          jwk.kid = value.id
          results.push({
            id: value.id,
            alg,
            created: new Date(value.created),
            public: publicKey,
            private: privateKey,
            expired: new Date(1735858114000),
            jwk,
          })
        }),
      ),
    )

    return results
  })

/**
 * Get all signing keys, generating a new one if none exist.
 * Returns keys sorted by creation date (newest first).
 */
export const signingKeys: Effect.Effect<KeyPair[], StorageError, StorageService> =
  Effect.gen(function* () {
    const results: KeyPair[] = []

    const mapKeyError = (error: unknown) =>
      new StorageError({ message: "Failed to import key", cause: error })

    yield* Storage.scan<SerializedKeyPair>(["signing:key"]).pipe(
      Stream.runForEach(([_key, value]) =>
        Effect.gen(function* () {
          const publicKey = yield* Effect.tryPromise({
            try: () => importSPKI(value.publicKey, value.alg, { extractable: true }),
            catch: mapKeyError,
          })
          const privateKey = yield* Effect.tryPromise({
            try: () => importPKCS8(value.privateKey, value.alg),
            catch: mapKeyError,
          })
          const jwk = yield* Effect.tryPromise({
            try: () => exportJWK(publicKey),
            catch: mapKeyError,
          })
          jwk.kid = value.id
          jwk.use = "sig"
          const keyPair: KeyPair = {
            id: value.id,
            alg: signingAlg,
            created: new Date(value.created),
            public: publicKey,
            private: privateKey,
            jwk,
          }
          if (value.expired) {
            keyPair.expired = new Date(value.expired)
          }
          results.push(keyPair)
        }),
      ),
    )

    results.sort((a, b) => b.created.getTime() - a.created.getTime())
    if (results.filter((item) => !item.expired).length) return results

    // Generate a new key
    const key = yield* Effect.promise(() =>
      generateKeyPair(signingAlg, { extractable: true }),
    )
    const serialized: SerializedKeyPair = {
      id: crypto.randomUUID(),
      publicKey: yield* Effect.promise(() => exportSPKI(key.publicKey)),
      privateKey: yield* Effect.promise(() => exportPKCS8(key.privateKey)),
      created: Date.now(),
      alg: signingAlg,
    }
    yield* Storage.set(["signing:key", serialized.id], serialized)

    // Recursively get all keys now that we've added one
    return yield* signingKeys
  })

/**
 * Get all encryption keys, generating a new one if none exist.
 * Returns keys sorted by creation date (newest first).
 */
export const encryptionKeys: Effect.Effect<KeyPair[], StorageError, StorageService> =
  Effect.gen(function* () {
    const results: KeyPair[] = []

    const mapKeyError = (error: unknown) =>
      new StorageError({ message: "Failed to import key", cause: error })

    yield* Storage.scan<SerializedKeyPair>(["encryption:key"]).pipe(
      Stream.runForEach(([_key, value]) =>
        Effect.gen(function* () {
          const publicKey = yield* Effect.tryPromise({
            try: () => importSPKI(value.publicKey, value.alg, { extractable: true }),
            catch: mapKeyError,
          })
          const privateKey = yield* Effect.tryPromise({
            try: () => importPKCS8(value.privateKey, value.alg),
            catch: mapKeyError,
          })
          const jwk = yield* Effect.tryPromise({
            try: () => exportJWK(publicKey),
            catch: mapKeyError,
          })
          jwk.kid = value.id
          const keyPair: KeyPair = {
            id: value.id,
            alg: encryptionAlg,
            created: new Date(value.created),
            public: publicKey,
            private: privateKey,
            jwk,
          }
          if (value.expired) {
            keyPair.expired = new Date(value.expired)
          }
          results.push(keyPair)
        }),
      ),
    )

    results.sort((a, b) => b.created.getTime() - a.created.getTime())
    if (results.filter((item) => !item.expired).length) return results

    // Generate a new key
    const key = yield* Effect.promise(() =>
      generateKeyPair(encryptionAlg, { extractable: true }),
    )
    const serialized: SerializedKeyPair = {
      id: crypto.randomUUID(),
      publicKey: yield* Effect.promise(() => exportSPKI(key.publicKey)),
      privateKey: yield* Effect.promise(() => exportPKCS8(key.privateKey)),
      created: Date.now(),
      alg: encryptionAlg,
    }
    yield* Storage.set(["encryption:key", serialized.id], serialized)

    // Recursively get all keys now that we've added one
    return yield* encryptionKeys
  })
