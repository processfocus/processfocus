/**
 * Unit tests for KeyManagementService.
 * Tests key generation, caching, and error handling.
 */
import { Effect, Layer } from "effect"
import {
  KeyManagementService,
  KeyManagementServiceLive,
  NoEncryptionKeysError,
  NoSigningKeysError,
} from "../../src/services/key-management"
import { MemoryStorageServiceLive } from "../../src/storage/memory"
import { StorageService } from "../../src/storage/storage"
import { describe, expect, it } from "bun:test"

/**
 * Helper to create KeyManagementService with fresh storage for each test.
 */
const makeTestLayer = () =>
  KeyManagementServiceLive.pipe(Layer.provide(MemoryStorageServiceLive))

describe("KeyManagementService", () => {
  describe("signingKey", () => {
    it("should generate a signing key when none exists", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          return yield* keyMgmt.signingKey
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.alg).toBe("ES256")
      expect(result.public).toBeDefined()
      expect(result.private).toBeDefined()
      expect(result.jwk).toBeDefined()
      expect(result.created).toBeInstanceOf(Date)
    })

    it("should return the same key on subsequent calls (caching)", async () => {
      const layer = makeTestLayer()

      const [key1, key2] = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          const first = yield* keyMgmt.signingKey
          const second = yield* keyMgmt.signingKey
          return [first, second] as const
        }).pipe(Effect.provide(layer)),
      )

      expect(key1.id).toBe(key2.id)
    })

    it("should cache keys across multiple service accesses", async () => {
      const layer = makeTestLayer()

      const [key1, key2] = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt1 = yield* KeyManagementService
          const first = yield* keyMgmt1.signingKey

          const keyMgmt2 = yield* KeyManagementService
          const second = yield* keyMgmt2.signingKey

          return [first, second] as const
        }).pipe(Effect.provide(layer)),
      )

      expect(key1.id).toBe(key2.id)
    })
  })

  describe("encryptionKey", () => {
    it("should generate an encryption key when none exists", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          return yield* keyMgmt.encryptionKey
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.alg).toBe("RSA-OAEP-512")
      expect(result.public).toBeDefined()
      expect(result.private).toBeDefined()
      expect(result.jwk).toBeDefined()
      expect(result.created).toBeInstanceOf(Date)
    })

    it("should return the same key on subsequent calls (caching)", async () => {
      const layer = makeTestLayer()

      const [key1, key2] = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          const first = yield* keyMgmt.encryptionKey
          const second = yield* keyMgmt.encryptionKey
          return [first, second] as const
        }).pipe(Effect.provide(layer)),
      )

      expect(key1.id).toBe(key2.id)
    })
  })

  describe("allSigningKeys", () => {
    it("should return all signing keys including legacy keys", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          return yield* keyMgmt.allSigningKeys
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(Array.isArray(result)).toBe(true)
      // Should have at least one key (newly generated)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it("should cache keys - multiple calls return same array", async () => {
      const layer = makeTestLayer()

      const [keys1, keys2] = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          const first = yield* keyMgmt.allSigningKeys
          const second = yield* keyMgmt.allSigningKeys
          return [first, second] as const
        }).pipe(Effect.provide(layer)),
      )

      expect(keys1.length).toBe(keys2.length)
      expect(keys1[0]?.id).toBe(keys2[0]?.id)
    })
  })

  describe("error handling", () => {
    it("NoSigningKeysError should have correct tag", () => {
      const error = new NoSigningKeysError({ message: "test" })
      expect(error._tag).toBe("@pf/NoSigningKeysError")
      expect(error.message).toBe("test")
    })

    it("NoEncryptionKeysError should have correct tag", () => {
      const error = new NoEncryptionKeysError({ message: "test" })
      expect(error._tag).toBe("@pf/NoEncryptionKeysError")
      expect(error.message).toBe("test")
    })
  })

  describe("concurrent access (race condition safety)", () => {
    it("should handle concurrent signingKey requests safely", async () => {
      const layer = makeTestLayer()

      const keys = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService

          // Fire off multiple concurrent requests
          const results = yield* Effect.all(
            [
              keyMgmt.signingKey,
              keyMgmt.signingKey,
              keyMgmt.signingKey,
              keyMgmt.signingKey,
              keyMgmt.signingKey,
            ],
            { concurrency: "unbounded" },
          )

          return results
        }).pipe(Effect.provide(layer)),
      )

      // All should return the same key
      const firstKeyId = keys[0]?.id
      for (const key of keys) {
        expect(key.id).toBe(firstKeyId)
      }
    })

    it("should handle concurrent encryptionKey requests safely", async () => {
      const layer = makeTestLayer()

      const keys = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService

          const results = yield* Effect.all(
            [
              keyMgmt.encryptionKey,
              keyMgmt.encryptionKey,
              keyMgmt.encryptionKey,
              keyMgmt.encryptionKey,
              keyMgmt.encryptionKey,
            ],
            { concurrency: "unbounded" },
          )

          return results
        }).pipe(Effect.provide(layer)),
      )

      const firstKeyId = keys[0]?.id
      for (const key of keys) {
        expect(key.id).toBe(firstKeyId)
      }
    })
  })

  describe("key persistence", () => {
    it("should persist signing keys to storage", async () => {
      // Use provideMerge to expose StorageService in the output
      const layer = KeyManagementServiceLive.pipe(
        Layer.provideMerge(MemoryStorageServiceLive),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          // Get a key via KeyManagementService
          const keyMgmt = yield* KeyManagementService
          const key = yield* keyMgmt.signingKey
          const keyId = key.id

          // Access storage directly to verify key was stored
          const storage = yield* StorageService
          const stored = yield* storage.get<{ id: string }>([
            "signing:key",
            keyId,
          ])

          return { keyId, storedId: stored?.id }
        }).pipe(Effect.provide(layer)),
      )

      expect(result.storedId).toBe(result.keyId)
    })

    it("should persist encryption keys to storage", async () => {
      // Use provideMerge to expose StorageService in the output
      const layer = KeyManagementServiceLive.pipe(
        Layer.provideMerge(MemoryStorageServiceLive),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const keyMgmt = yield* KeyManagementService
          const key = yield* keyMgmt.encryptionKey
          const keyId = key.id

          const storage = yield* StorageService
          const stored = yield* storage.get<{ id: string }>([
            "encryption:key",
            keyId,
          ])

          return { keyId, storedId: stored?.id }
        }).pipe(Effect.provide(layer)),
      )

      expect(result.storedId).toBe(result.keyId)
    })
  })
})
