import { Effect } from "effect"
import { graphqlRequest } from "../src/utils/graphql-client"
import { useSerializedTestState } from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

const originalFetch = globalThis.fetch

useSerializedTestState()

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("graphql client", () => {
  it("aborts the underlying fetch when timeoutMs elapses", async () => {
    let aborted = false

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!(signal instanceof AbortSignal)) {
          reject(new Error("Expected abort signal"))
          return
        }

        signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("Aborted", "AbortError"))
        })
      })) as typeof fetch

    const exit = await Effect.runPromiseExit(
      graphqlRequest(
        "https://example.com/graphql",
        "test-token",
        "query Ping { ping }",
        {},
        { timeoutMs: 10 },
      ),
    )

    expect(aborted).toBe(true)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("GraphQL request timed out")
    }
  })
})
