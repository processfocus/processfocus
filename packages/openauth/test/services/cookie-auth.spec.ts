/**
 * Unit tests for CookieAuthService.
 * Tests cookie operations and refresh token invalidation.
 */
import { Effect, Layer } from "effect"
import {
  CookieAuthService,
  CookieAuthServiceLive,
} from "../../src/services/cookie-auth"
import { EncryptionServiceLive } from "../../src/services/encryption"
import { KeyManagementServiceLive } from "../../src/services/key-management"
import { MemoryStorageServiceLive } from "../../src/storage/memory"
import { Storage as StorageOps, StorageService } from "../../src/storage/storage"
import { describe, expect, it } from "bun:test"

/**
 * Helper to create CookieAuthService with all dependencies.
 */
const makeTestLayer = () =>
  CookieAuthServiceLive.pipe(
    Layer.provide(EncryptionServiceLive),
    Layer.provide(KeyManagementServiceLive),
    Layer.provide(MemoryStorageServiceLive),
  )

describe("CookieAuthService", () => {
  describe("set", () => {
    it("should create a Set-Cookie header with encrypted value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.set("session", 3600, { user: "test" }, true)
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toContain("session=")
      expect(result).toContain("Max-Age=3600")
      expect(result).toContain("HttpOnly")
      expect(result).toContain("Secure")
      expect(result).toContain("SameSite=None")
    })

    it("should use SameSite=Lax for non-secure requests", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.set("session", 3600, { user: "test" }, false)
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toContain("SameSite=Lax")
      expect(result).not.toContain("Secure")
    })

    it("should handle different value types", async () => {
      const layer = makeTestLayer()

      // Test string
      const strResult = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.set("str", 3600, "hello", true)
        }).pipe(Effect.provide(layer)),
      )
      expect(strResult).toContain("str=")

      // Test number
      const numResult = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.set("num", 3600, 42, true)
        }).pipe(Effect.provide(layer)),
      )
      expect(numResult).toContain("num=")

      // Test object
      const objResult = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.set("obj", 3600, { complex: true }, true)
        }).pipe(Effect.provide(layer)),
      )
      expect(objResult).toContain("obj=")
    })
  })

  describe("get", () => {
    it("should decrypt and return cookie value", async () => {
      const layer = makeTestLayer()
      const originalValue = { user: "testuser", role: "admin" }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService

          // Set a cookie to get the encrypted value
          const setCookie = yield* cookieAuth.set(
            "session",
            3600,
            originalValue,
            true,
          )

          // Extract the cookie value from Set-Cookie header
          const match = setCookie.match(/session=([^;]+)/)
          const cookieValue = match?.[1]
          expect(cookieValue).toBeDefined()

          // Build a Cookie header as it would appear in a request
          const cookieHeader = `session=${cookieValue}`

          // Get the decrypted value
          return yield* cookieAuth.get(cookieHeader, "session")
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toEqual(originalValue)
    })

    it("should return undefined for missing cookie", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.get("other=value", "session")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBeUndefined()
    })

    it("should return undefined for empty cookie header", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.get("", "session")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBeUndefined()
    })

    it("should return undefined for invalid encrypted value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          // Invalid JWE will fail to decrypt
          return yield* cookieAuth.get("session=invalid-encrypted-value", "session")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      // Should gracefully return undefined instead of throwing
      expect(result).toBeUndefined()
    })

    it("should handle multiple cookies in header", async () => {
      const layer = makeTestLayer()

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService

          // Set two cookies
          const cookie1 = yield* cookieAuth.set("first", 3600, "value1", true)
          const cookie2 = yield* cookieAuth.set("second", 3600, "value2", true)

          // Extract values
          const value1 = cookie1.match(/first=([^;]+)/)?.[1]
          const value2 = cookie2.match(/second=([^;]+)/)?.[1]

          // Build combined cookie header
          const cookieHeader = `first=${value1}; second=${value2}`

          // Get each value
          const first = yield* cookieAuth.get(cookieHeader, "first")
          const second = yield* cookieAuth.get(cookieHeader, "second")

          return { first, second }
        }).pipe(Effect.provide(layer)),
      )

      expect(result.first).toBe("value1")
      expect(result.second).toBe("value2")
    })

    it("should handle cookies with equals in value", async () => {
      const layer = makeTestLayer()

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService

          // Set a cookie
          const setCookie = yield* cookieAuth.set("test", 3600, "data", true)
          const value = setCookie.match(/test=([^;]+)/)?.[1]

          // The encrypted JWE contains = characters in base64
          // Simulate a header with the full value (which contains =)
          const cookieHeader = `test=${value}`

          return yield* cookieAuth.get(cookieHeader, "test")
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toBe("data")
    })
  })

  describe("unset", () => {
    it("should create a Set-Cookie header that clears the cookie", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.unset("session")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toContain("session=")
      expect(result).toContain("Max-Age=0")
      expect(result).toContain("Expires=")
    })

    it("should set expiry to epoch time", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          return yield* cookieAuth.unset("session")
        }).pipe(Effect.provide(makeTestLayer())),
      )

      // Should contain Thu, 01 Jan 1970 (epoch)
      expect(result).toContain("1970")
    })
  })

  describe("invalidate", () => {
    it("should remove all refresh tokens for a subject", async () => {
      // Use provideMerge to expose StorageService in the output
      const fullLayer = CookieAuthServiceLive.pipe(
        Layer.provideMerge(EncryptionServiceLive),
        Layer.provideMerge(KeyManagementServiceLive),
        Layer.provideMerge(MemoryStorageServiceLive),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService

          // Store some refresh tokens for a subject using StorageOps (matches invalidate)
          yield* StorageOps.set(["oauth:refresh", "user123", "token1"], {
            token: "refresh1",
          })
          yield* StorageOps.set(["oauth:refresh", "user123", "token2"], {
            token: "refresh2",
          })
          yield* StorageOps.set(["oauth:refresh", "user456", "token3"], {
            token: "refresh3",
          })

          // Verify tokens exist
          const before1 = yield* StorageOps.get(["oauth:refresh", "user123", "token1"])
          const before2 = yield* StorageOps.get(["oauth:refresh", "user123", "token2"])
          const before3 = yield* StorageOps.get(["oauth:refresh", "user456", "token3"])
          expect(before1).toBeDefined()
          expect(before2).toBeDefined()
          expect(before3).toBeDefined()

          // Invalidate user123's tokens
          yield* cookieAuth.invalidate("user123")

          // user123's tokens should be gone
          const after1 = yield* StorageOps.get(["oauth:refresh", "user123", "token1"])
          const after2 = yield* StorageOps.get(["oauth:refresh", "user123", "token2"])
          expect(after1).toBeUndefined()
          expect(after2).toBeUndefined()

          // user456's token should still exist
          const after3 = yield* StorageOps.get(["oauth:refresh", "user456", "token3"])
          expect(after3).toBeDefined()
        }).pipe(Effect.provide(fullLayer)),
      )
    })

    it("should succeed even when no tokens exist", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService
          // Should not throw when there are no tokens to invalidate
          yield* cookieAuth.invalidate("nonexistent-user")
          return "success"
        }).pipe(Effect.provide(makeTestLayer())),
      )

      expect(result).toBe("success")
    })

    it("should handle subject with special characters", async () => {
      // Use provideMerge to expose StorageService in the output
      const fullLayer = CookieAuthServiceLive.pipe(
        Layer.provideMerge(EncryptionServiceLive),
        Layer.provideMerge(KeyManagementServiceLive),
        Layer.provideMerge(MemoryStorageServiceLive),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* StorageService
          const cookieAuth = yield* CookieAuthService

          const specialSubject = "user@example.com"

          // Store a token for this subject using StorageOps namespace (which encodes keys)
          // This matches how tokens are stored in production
          yield* StorageOps.set(
            ["oauth:refresh", specialSubject, "token1"],
            { token: "value" },
          )

          // Verify it exists
          const before = yield* StorageOps.get([
            "oauth:refresh",
            specialSubject,
            "token1",
          ])
          expect(before).toBeDefined()

          // Invalidate
          yield* cookieAuth.invalidate(specialSubject)

          // Should be gone
          const after = yield* StorageOps.get([
            "oauth:refresh",
            specialSubject,
            "token1",
          ])
          expect(after).toBeUndefined()
        }).pipe(Effect.provide(fullLayer)),
      )
    })
  })

  describe("integration: set and get round-trip", () => {
    it("should round-trip complex authorization state", async () => {
      const layer = makeTestLayer()
      const authState = {
        clientId: "my-app",
        redirectUri: "https://example.com/callback",
        scope: ["openid", "profile"],
        state: "random-state-value",
        nonce: "random-nonce",
        codeChallenge: "challenge123",
        codeChallengeMethod: "S256",
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cookieAuth = yield* CookieAuthService

          // Set the authorization cookie
          const setCookie = yield* cookieAuth.set(
            "authorization",
            600,
            authState,
            true,
          )

          // Extract and rebuild as request would
          const value = setCookie.match(/authorization=([^;]+)/)?.[1]
          const cookieHeader = `authorization=${value}`

          // Get it back
          return yield* cookieAuth.get(cookieHeader, "authorization")
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toEqual(authState)
    })
  })
})
