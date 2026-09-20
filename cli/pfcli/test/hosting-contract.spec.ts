import { Effect } from "effect"
import { CliError } from "../src/errors"
import type { Credentials } from "../src/utils/credentials"
import { ensureHostingContractCompatible } from "../src/utils/graphql-client"
import { afterEach, describe, expect, it } from "bun:test"

const credentials: Credentials = {
  version: 1,
  baseUrl: "https://deploy.example.test",
  accessToken: "token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  loginAt: "2026-01-01T00:00:00.000Z",
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (data: unknown) =>
  (async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch

const notFoundResponse = (async () =>
  new Response("not-found", { status: 404 })) as unknown as typeof fetch

const hostingContract = (major: number) => ({
  hostingContract: {
    format: "processfocus/hosting-contract",
    version: 1,
    major,
    capabilities: ["deploy"],
  },
})

const runWithFetch = <A, E>(
  fetchImpl: typeof fetch,
  effect: Effect.Effect<A, E>,
) =>
  Effect.suspend(() => {
    globalThis.fetch = fetchImpl
    return effect
  }).pipe(Effect.runPromise)

describe("hosting contract negotiation", () => {
  it("proceeds when the Backend does not expose hostingContract", async () => {
    await expect(
      runWithFetch(
        notFoundResponse,
        ensureHostingContractCompatible(credentials),
      ),
    ).resolves.toBeUndefined()
  })

  it("proceeds when the Backend reports the supported major", async () => {
    await expect(
      runWithFetch(
        jsonResponse(hostingContract(1)),
        ensureHostingContractCompatible(credentials),
      ),
    ).resolves.toBeUndefined()
  })

  it("proceeds when the Backend contract is structurally unexpected", async () => {
    await expect(
      runWithFetch(
        jsonResponse({
          hostingContract: {
            format: "other",
            version: 99,
            major: 1,
            capabilities: [],
          },
        }),
        ensureHostingContractCompatible(credentials),
      ),
    ).resolves.toBeUndefined()
  })

  it("fails before mutation when the Backend reports an unsupported major", async () => {
    const error = await Effect.suspend(() => {
      globalThis.fetch = jsonResponse(hostingContract(2))
      return ensureHostingContractCompatible(credentials)
    }).pipe(Effect.flip, Effect.runPromise)

    expect(error).toBeInstanceOf(CliError)
    expect(error.message).toContain("major 2 is not supported")
    expect(error.graphqlErrorMessage).toContain("Update @processfocus")
  })
})
