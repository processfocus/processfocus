import {
  clearPickerTokenCache,
  getCachedPickerToken,
  setCachedPickerToken,
} from "./picker-token-cache"
import { afterEach, describe, expect, it } from "bun:test"

describe("picker token cache", () => {
  afterEach(clearPickerTokenCache)

  it("reuses a token while it has more than one minute remaining", () => {
    setCachedPickerToken({
      clientId: "client-a",
      token: "token-a",
      expiresInSeconds: 3_600,
      now: 1_000,
    })

    expect(
      getCachedPickerToken({
        clientId: "client-a",
        now: 3_540_999,
      }),
    ).toBe("token-a")
  })

  it("evicts a token once it reaches the expiry safety buffer", () => {
    setCachedPickerToken({
      clientId: "client-a",
      token: "token-a",
      expiresInSeconds: 3_600,
      now: 1_000,
    })

    expect(
      getCachedPickerToken({
        clientId: "client-a",
        now: 3_541_000,
      }),
    ).toBeNull()
    expect(
      getCachedPickerToken({
        clientId: "client-a",
        now: 1_001,
      }),
    ).toBeNull()
  })

  it("isolates tokens by OAuth client", () => {
    setCachedPickerToken({
      clientId: "client-a",
      token: "token-a",
      expiresInSeconds: 3_600,
      now: 1_000,
    })

    expect(
      getCachedPickerToken({
        clientId: "client-b",
        now: 1_001,
      }),
    ).toBeNull()
  })

  it("clears every cached token", () => {
    setCachedPickerToken({
      clientId: "client-a",
      token: "token-a",
      expiresInSeconds: 3_600,
      now: 1_000,
    })
    setCachedPickerToken({
      clientId: "client-b",
      token: "token-b",
      expiresInSeconds: 3_600,
      now: 1_000,
    })

    clearPickerTokenCache()

    expect(
      getCachedPickerToken({ clientId: "client-a", now: 1_001 }),
    ).toBeNull()
    expect(
      getCachedPickerToken({ clientId: "client-b", now: 1_001 }),
    ).toBeNull()
  })
})
