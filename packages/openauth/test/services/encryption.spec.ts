/**
 * Unit tests for EncryptionService.
 * Tests encrypt/decrypt round-trips and error handling.
 */
import { Effect, Layer } from "effect"
import { EncryptionService, EncryptionServiceLive } from "../../src/services/encryption"
import { KeyManagementServiceLive } from "../../src/services/key-management"
import { MemoryStorageServiceLive } from "../../src/storage/memory"
import { describe, expect, it } from "bun:test"

/**
 * Helper to create EncryptionService with all dependencies.
 */
const makeTestLayer = () =>
  EncryptionServiceLive.pipe(
    Layer.provide(KeyManagementServiceLive),
    Layer.provide(MemoryStorageServiceLive),
  )

describe("EncryptionService", () => {
  describe("encrypt/decrypt round-trip", () => {
    it("should encrypt and decrypt a string", async () => {
      const original = "hello world"

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should encrypt and decrypt a number", async () => {
      const original = 42

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should encrypt and decrypt a boolean", async () => {
      const original = true

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should encrypt and decrypt null", async () => {
      const original = null

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should encrypt and decrypt an object", async () => {
      const original = { foo: "bar", count: 123, nested: { value: true } }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toEqual(original)
    })

    it("should encrypt and decrypt an array", async () => {
      const original = [1, "two", { three: 3 }, null, true]

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toEqual(original)
    })

    it("should handle empty string", async () => {
      const original = ""

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should handle empty object", async () => {
      const original = {}

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toEqual(original)
    })

    it("should handle empty array", async () => {
      const original: unknown[] = []

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toEqual(original)
    })

    it("should handle special characters in strings", async () => {
      const original = "Hello\nWorld\t\u0000\u{1F600}"

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe(original)
    })

    it("should handle large objects", async () => {
      const original = {
        items: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          data: "x".repeat(100),
        })),
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt(original)
          const decrypted = yield* encryption.decrypt(encrypted)
          return decrypted
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toEqual(original)
    })
  })

  describe("encrypt output format", () => {
    it("should produce a JWE compact serialization string", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          return yield* encryption.encrypt("test")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      // JWE compact has 5 parts separated by dots
      const parts = result.split(".")
      expect(parts.length).toBe(5)
    })

    it("should produce different ciphertext for same plaintext (non-deterministic)", async () => {
      const layer = makeTestLayer()
      const original = "same plaintext"

      const [enc1, enc2] = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const first = yield* encryption.encrypt(original)
          const second = yield* encryption.encrypt(original)
          return [first, second] as const
        }).pipe(Effect.provide(layer)),
      )

      // The encrypted values should differ due to random IV
      expect(enc1).not.toBe(enc2)
    })
  })

  describe("decrypt error handling", () => {
    it("should fail to decrypt invalid JWE string", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          return yield* encryption.decrypt("not-a-valid-jwe").pipe(
            Effect.exit,
          )
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result._tag).toBe("Failure")
    })

    it("should fail to decrypt JWE with wrong key", async () => {
      // Create two separate layers with different keys
      const layer1 = makeTestLayer()
      const layer2 = makeTestLayer()

      const encrypted = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          return yield* encryption.encrypt("secret data")
        }).pipe(Effect.provide(layer1)),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          return yield* encryption.decrypt(encrypted).pipe(Effect.exit)
        }).pipe(Effect.provide(layer2)),
      )

      expect(result._tag).toBe("Failure")
    })

    it("should fail to decrypt tampered ciphertext", async () => {
      const layer = makeTestLayer()

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService
          const encrypted = yield* encryption.encrypt("secret")

          // Tamper with the ciphertext (4th part of JWE)
          const parts = encrypted.split(".")
          parts[3] = `tampered${parts[3]?.slice(8)}`
          const tampered = parts.join(".")

          return yield* encryption.decrypt(tampered).pipe(Effect.exit)
        }).pipe(Effect.provide(layer)),
      )

      expect(result._tag).toBe("Failure")
    })
  })

  describe("key consistency", () => {
    it("should use the same key for multiple operations", async () => {
      const layer = makeTestLayer()

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const encryption = yield* EncryptionService

          // Encrypt multiple values
          const enc1 = yield* encryption.encrypt("value1")
          const enc2 = yield* encryption.encrypt("value2")
          const enc3 = yield* encryption.encrypt("value3")

          // Decrypt them all - should work if same key is used
          const dec1 = yield* encryption.decrypt(enc1)
          const dec2 = yield* encryption.decrypt(enc2)
          const dec3 = yield* encryption.decrypt(enc3)

          return [dec1, dec2, dec3] as const
        }).pipe(Effect.provide(layer)),
      )

      expect(results).toEqual(["value1", "value2", "value3"])
    })
  })
})
