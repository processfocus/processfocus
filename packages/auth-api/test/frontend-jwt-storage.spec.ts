import { Effect } from "effect"
import { MemoryStorageServiceLive, type StorageService } from "@pf/openauth"
import {
  createClientJwt,
  readFrontendJwt,
  storeFrontendJwt,
} from "../src/lib/create-authentication-server"
import { describe, expect, it } from "bun:test"

const StorageLayer = MemoryStorageServiceLive

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, StorageService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(StorageLayer)))

const runWithStorageExit = <A, E>(
  effect: Effect.Effect<A, E, StorageService>,
) => Effect.runPromiseExit(effect.pipe(Effect.provide(StorageLayer)))

describe("storeFrontendJwt / readFrontendJwt", () => {
  it("round-trips a token", async () => {
    const program = Effect.gen(function* () {
      yield* storeFrontendJwt("frontend", "tok-123")
      const token = yield* readFrontendJwt("frontend")
      expect(token).toBe("tok-123")
    })

    await runWithStorage(program)
  })

  it("returns undefined when no token stored", async () => {
    const program = Effect.gen(function* () {
      const token = yield* readFrontendJwt("frontend")
      expect(token).toBeUndefined()
    })

    await runWithStorage(program)
  })

  it("overwrites an existing token", async () => {
    const program = Effect.gen(function* () {
      yield* storeFrontendJwt("frontend", "old-token")
      yield* storeFrontendJwt("frontend", "new-token")
      const token = yield* readFrontendJwt("frontend")
      expect(token).toBe("new-token")
    })

    await runWithStorage(program)
  })

  it("isolates tokens by client id", async () => {
    const program = Effect.gen(function* () {
      yield* storeFrontendJwt("client-a", "token-a")
      yield* storeFrontendJwt("client-b", "token-b")
      expect(yield* readFrontendJwt("client-a")).toBe("token-a")
      expect(yield* readFrontendJwt("client-b")).toBe("token-b")
    })

    await runWithStorage(program)
  })
})

describe("createClientJwt + storeFrontendJwt integration", () => {
  it("mints a JWT and stores it, then reads it back", async () => {
    const program = Effect.gen(function* () {
      const token = yield* createClientJwt({
        clientId: "frontend",
        issuerUrl: "http://localhost:4020",
        audience: "graphql-api",
      })

      expect(token).toBeDefined()
      expect(token.split(".")).toHaveLength(3) // JWT has 3 parts

      yield* storeFrontendJwt("frontend", token)
      const readBack = yield* readFrontendJwt("frontend")
      expect(readBack).toBe(token)
    })

    await runWithStorage(program)
  })

  it("rejects empty clientId", async () => {
    const program = createClientJwt({
      clientId: "",
      issuerUrl: "http://localhost:4020",
      audience: "graphql-api",
    })

    const result = await runWithStorageExit(program)
    expect(result._tag).toBe("Failure")
  })

  it("rejects invalid issuer URL", async () => {
    const program = createClientJwt({
      clientId: "frontend",
      issuerUrl: "not-a-url",
      audience: "graphql-api",
    })

    const result = await runWithStorageExit(program)
    expect(result._tag).toBe("Failure")
  })
})
