/**
 * Unit tests for ClientRegistryService.
 * Tests static clients, dynamic clients, and validation rules.
 */
import { Effect, Either } from "effect"
import type { IssuerClient } from "../../src/issuer"
import {
  ClientRegistryError,
  ClientRegistryService,
  buildClientRegistry,
  makeClientRegistryService,
} from "../../src/services/client-registry"
import { describe, expect, it } from "bun:test"

/**
 * Helper to run buildClientRegistry and unwrap the Effect.
 */
function runBuildRegistry(clients: IssuerClient[]) {
  return Effect.runSync(buildClientRegistry(clients))
}

/**
 * Helper to run buildClientRegistry and get the error.
 */
function runBuildRegistryError(clients: IssuerClient[]) {
  const result = Effect.runSync(Effect.either(buildClientRegistry(clients)))
  if (Either.isLeft(result)) {
    return result.left
  }
  throw new Error("Expected error but got success")
}

describe("ClientRegistryService", () => {
  describe("buildClientRegistry", () => {
    it("should build registry from valid client config", () => {
      const clients: IssuerClient[] = [
        {
          id: "client1",
          redirectUris: ["https://example.com/callback"],
        },
      ]

      const registry = runBuildRegistry(clients)

      expect(registry.size).toBe(1)
      expect(registry.get("client1")).toBeDefined()
      expect(registry.get("client1")?.isPublic).toBe(true)
    })

    it("should normalize redirect URIs", () => {
      const clients: IssuerClient[] = [
        {
          id: "client1",
          redirectUris: ["https://example.com/callback/"],
        },
      ]

      const registry = runBuildRegistry(clients)
      const client = registry.get("client1")

      // Trailing slash should be removed
      expect(client?.redirectUris[0]).toBe("https://example.com/callback")
    })

    it("should normalize CORS origins", () => {
      const clients: IssuerClient[] = [
        {
          id: "client1",
          redirectUris: ["https://example.com/callback"],
          corsOrigins: ["https://example.com:443/path"],
        },
      ]

      const registry = runBuildRegistry(clients)
      const client = registry.get("client1")

      // Should be normalized to origin (no path)
      expect(client?.corsOrigins[0]).toBe("https://example.com")
    })

    it("should mark confidential clients correctly", () => {
      const clients: IssuerClient[] = [
        {
          id: "confidential",
          redirectUris: ["https://example.com/callback"],
          secretHash: "hashed-secret",
        },
      ]

      const registry = runBuildRegistry(clients)
      const client = registry.get("confidential")

      expect(client?.isPublic).toBe(false)
      expect(client?.secretHash).toBe("hashed-secret")
    })

    it("should use client id as audience if not specified", () => {
      const clients: IssuerClient[] = [
        {
          id: "myapp",
          redirectUris: ["https://example.com/callback"],
        },
      ]

      const registry = runBuildRegistry(clients)
      const client = registry.get("myapp")

      expect(client?.audience).toBe("myapp")
    })

    it("should use custom audience if specified", () => {
      const clients: IssuerClient[] = [
        {
          id: "myapp",
          redirectUris: ["https://example.com/callback"],
          audience: "custom-audience",
        },
      ]

      const registry = runBuildRegistry(clients)
      const client = registry.get("myapp")

      expect(client?.audience).toBe("custom-audience")
    })

    describe("validation errors", () => {
      it("should fail on missing client id", () => {
        const clients = [
          {
            id: "",
            redirectUris: ["https://example.com/callback"],
          },
        ] as IssuerClient[]

        // Empty string is falsy, so should fail
        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toContain("missing an id")
      })

      it("should fail on duplicate client id", () => {
        const clients: IssuerClient[] = [
          {
            id: "duplicate",
            redirectUris: ["https://example.com/callback"],
          },
          {
            id: "duplicate",
            redirectUris: ["https://other.com/callback"],
          },
        ]

        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toBe("Duplicate client id configured: duplicate")
        expect(error.clientId).toBe("duplicate")
      })

      it("should fail on empty secretHash", () => {
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://example.com/callback"],
            secretHash: "   ",
          },
        ]

        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toContain("has empty secretHash")
      })

      it("should fail on public client without redirect URIs", () => {
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: [],
          },
        ]

        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toContain("must declare at least one redirect URI")
      })

      it("should throw on invalid CORS origin protocol", () => {
        // This error happens in normalizeOrigin which still throws (URL parsing)
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://example.com/callback"],
            corsOrigins: ["ftp://example.com"],
          },
        ]

        expect(() => runBuildRegistry(clients)).toThrow(
          "Origin must use http or https",
        )
      })

      it("should fail when tokenEndpointAuthMethod is none but secretHash is set", () => {
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://example.com/callback"],
            secretHash: "some-hash",
            tokenEndpointAuthMethod: "none",
          },
        ]

        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toContain(
          "cannot set a secretHash while using public authentication",
        )
      })

      it("should fail when auth method requires secret but none provided", () => {
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://example.com/callback"],
            tokenEndpointAuthMethod: "client_secret_basic",
          },
        ]

        const error = runBuildRegistryError(clients)
        expect(error).toBeInstanceOf(ClientRegistryError)
        expect(error.message).toContain(
          "must configure a secretHash for client_secret_basic",
        )
      })
    })
  })

  describe("makeClientRegistryService", () => {
    describe("static clients", () => {
      it("should return static client by id", async () => {
        const clients: IssuerClient[] = [
          {
            id: "static-client",
            redirectUris: ["https://example.com/callback"],
          },
        ]

        const layer = makeClientRegistryService(clients)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("static-client")
          }).pipe(Effect.provide(layer)),
        )

        expect(result).toBeDefined()
        expect(result?.id).toBe("static-client")
      })

      it("should return undefined for unknown client", async () => {
        const clients: IssuerClient[] = [
          {
            id: "known-client",
            redirectUris: ["https://example.com/callback"],
          },
        ]

        const layer = makeClientRegistryService(clients)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("unknown-client")
          }).pipe(Effect.provide(layer)),
        )

        expect(result).toBeUndefined()
      })

      it("should expose staticClients map", async () => {
        const clients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://example.com/callback"],
          },
          {
            id: "client2",
            redirectUris: ["https://example2.com/callback"],
          },
        ]

        const layer = makeClientRegistryService(clients)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return registry.staticClients
          }).pipe(Effect.provide(layer)),
        )

        expect(result.size).toBe(2)
        expect(result.get("client1")).toBeDefined()
        expect(result.get("client2")).toBeDefined()
      })

      it("should expose configuredClientIds", async () => {
        const clients: IssuerClient[] = [
          {
            id: "first",
            redirectUris: ["https://example.com/callback"],
          },
          {
            id: "second",
            redirectUris: ["https://example2.com/callback"],
          },
        ]

        const layer = makeClientRegistryService(clients)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return registry.configuredClientIds
          }).pipe(Effect.provide(layer)),
        )

        expect(result).toEqual(["first", "second"])
      })
    })

    describe("dynamic client resolver", () => {
      it("should resolve dynamic client when static lookup fails", async () => {
        const staticClients: IssuerClient[] = []

        const dynamicResolver = (clientId: string) =>
          Effect.succeed(
            clientId === "dynamic-client"
              ? {
                  id: "dynamic-client",
                  redirectUris: ["https://dynamic.com/callback"],
                  secretHash: "dynamic-secret-hash",
                }
              : undefined,
          )

        const layer = makeClientRegistryService(staticClients, dynamicResolver)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("dynamic-client")
          }).pipe(Effect.provide(layer)),
        )

        expect(result).toBeDefined()
        expect(result?.id).toBe("dynamic-client")
        expect(result?.isPublic).toBe(false)
      })

      it("should prefer static client over dynamic", async () => {
        const staticClients: IssuerClient[] = [
          {
            id: "client1",
            redirectUris: ["https://static.com/callback"],
          },
        ]

        const dynamicResolver = (_clientId: string) =>
          Effect.succeed({
            id: "client1",
            redirectUris: ["https://dynamic.com/callback"],
            secretHash: "dynamic-secret",
          })

        const layer = makeClientRegistryService(staticClients, dynamicResolver)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("client1")
          }).pipe(Effect.provide(layer)),
        )

        // Should return static client, not dynamic
        expect(result?.redirectUris[0]).toBe("https://static.com/callback")
        expect(result?.isPublic).toBe(true) // Static client was public
      })

      it("should reject dynamic client without secretHash", async () => {
        const staticClients: IssuerClient[] = []

        const dynamicResolver = (clientId: string) =>
          Effect.succeed(
            clientId === "public-dynamic"
              ? {
                  id: "public-dynamic",
                  redirectUris: ["https://dynamic.com/callback"],
                  // No secretHash - dynamic clients must be confidential
                }
              : undefined,
          )

        const layer = makeClientRegistryService(staticClients, dynamicResolver)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("public-dynamic")
          }).pipe(Effect.provide(layer)),
        )

        // Should be rejected (return undefined)
        expect(result).toBeUndefined()
      })

      it("should normalize dynamic client redirect URIs", async () => {
        const staticClients: IssuerClient[] = []

        const dynamicResolver = (clientId: string) =>
          Effect.succeed(
            clientId === "dynamic"
              ? {
                  id: "dynamic",
                  redirectUris: ["https://dynamic.com/callback/"],
                  secretHash: "hash",
                }
              : undefined,
          )

        const layer = makeClientRegistryService(staticClients, dynamicResolver)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("dynamic")
          }).pipe(Effect.provide(layer)),
        )

        // Trailing slash should be removed
        expect(result?.redirectUris[0]).toBe("https://dynamic.com/callback")
      })

      it("should return undefined when resolver returns undefined", async () => {
        const staticClients: IssuerClient[] = []

        const dynamicResolver = (_clientId: string) =>
          Effect.as(Effect.void, undefined as IssuerClient | undefined)

        const layer = makeClientRegistryService(staticClients, dynamicResolver)

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* ClientRegistryService
            return yield* registry.getClient("any-client")
          }).pipe(Effect.provide(layer)),
        )

        expect(result).toBeUndefined()
      })
    })
  })
})
