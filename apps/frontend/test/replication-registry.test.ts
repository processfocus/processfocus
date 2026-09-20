import { beforeEach, describe, expect, test } from "vitest"
import {
  beginReplicationCredentialRefresh,
  clearReplicationRegistry,
  getReplicationExpiry,
  invalidateReplicationCredentials,
  recreateAllReplications,
  refreshReplicationCredentials,
  registerReplication,
  unregisterReplication,
} from "../lib/collections/replication-registry"

const runtimeConfig = {
  appSyncEventsHttpEndpoint: "http://localhost:4000/appsync-events",
  graphqlEndpoint: "http://localhost:4000/graphql",
  userId: "user-1",
  wsEndpoint: "ws://localhost:4000/graphql",
}

describe("replication registry", () => {
  beforeEach(() => {
    clearReplicationRegistry()
  })

  test("clears stale recreators when RxDB is removed", async () => {
    let called = false
    registerReplication(
      "Execution",
      async () => {
        called = true
      },
      async () => {
        called = true
      },
    )

    clearReplicationRegistry()

    const result = await recreateAllReplications(runtimeConfig)
    await refreshReplicationCredentials(2_000_000_000, "scope")

    expect(result).toEqual({ success: true, errors: [] })
    expect(called).toBe(false)
  })

  test("unregisters individual recreators", async () => {
    let called = false
    registerReplication(
      "Execution",
      async () => {
        called = true
      },
      async () => {
        called = true
      },
    )
    unregisterReplication("Execution")

    const result = await recreateAllReplications(runtimeConfig)
    await refreshReplicationCredentials(2_000_000_000, "scope")

    expect(result).toEqual({ success: true, errors: [] })
    expect(called).toBe(false)
  })

  test("pauses initialization during exchange and retains committed expiry for late registrations", async () => {
    beginReplicationCredentialRefresh("scope")
    const waiting = getReplicationExpiry("scope", 100)
    expect(waiting).toBeInstanceOf(Promise)
    await refreshReplicationCredentials(200, "scope")
    expect(await waiting).toBe(200)
    expect(getReplicationExpiry("scope", 100)).toBe(200)
    expect(getReplicationExpiry("other-actor", 300)).toBe(300)
    clearReplicationRegistry()
    expect(getReplicationExpiry("scope", 100)).toBe(100)
  })

  test("failed exchange never releases a new collection with the old expiry", async () => {
    beginReplicationCredentialRefresh("scope")
    const waiting = Promise.resolve(getReplicationExpiry("scope", 100))
    invalidateReplicationCredentials("scope")
    await expect(waiting).rejects.toThrow("Session refresh failed")
    expect(() => getReplicationExpiry("scope", 100)).toThrow(
      "Session refresh failed",
    )
  })

  test("a superseded renewal cannot finish the local stream refresh barrier", async () => {
    const gate = Promise.withResolvers<void>()
    registerReplication(
      "Execution",
      async () => {},
      () => gate.promise,
    )
    const oldRefresh = refreshReplicationCredentials(200, "scope")
    clearReplicationRegistry()
    await refreshReplicationCredentials(300, "scope")
    gate.resolve()
    await expect(oldRefresh).rejects.toThrow(
      "Session changed during credential refresh",
    )
    expect(getReplicationExpiry("scope", 100)).toBe(300)
  })
})
