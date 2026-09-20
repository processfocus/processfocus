import { afterAll, beforeEach, describe, expect, test } from "vitest"
import {
  consumeListStale,
  markListStale,
} from "../app/(protected)/lists/lib/list-refresh"

const browserGlobal = globalThis as typeof globalThis & {
  window?: typeof globalThis
  sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  browserGlobal,
  "window",
)
const originalSessionStorageDescriptor = Object.getOwnPropertyDescriptor(
  browserGlobal,
  "sessionStorage",
)

let sessionStorageState = new Map<string, string>()

beforeEach(() => {
  sessionStorageState = new Map<string, string>()

  Object.defineProperty(browserGlobal, "window", {
    configurable: true,
    writable: true,
    value: browserGlobal,
  })

  Object.defineProperty(browserGlobal, "sessionStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => sessionStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorageState.set(key, value)
      },
      removeItem: (key: string) => {
        sessionStorageState.delete(key)
      },
    },
  })
})

afterAll(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(browserGlobal, "window", originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(browserGlobal, "window")
  }

  if (originalSessionStorageDescriptor) {
    Object.defineProperty(
      browserGlobal,
      "sessionStorage",
      originalSessionStorageDescriptor,
    )
  } else {
    Reflect.deleteProperty(browserGlobal, "sessionStorage")
  }
})

describe("list refresh marker", () => {
  test("consumes a stale marker once for the matching list", () => {
    markListStale("/enquiries")

    expect(consumeListStale("/other-list")).toBe(false)
    expect(consumeListStale("/enquiries")).toBe(true)
    expect(consumeListStale("/enquiries")).toBe(false)
  })

  test("ignores storage failures", () => {
    Object.defineProperty(browserGlobal, "sessionStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: () => {
          throw new Error("storage unavailable")
        },
        setItem: () => {
          throw new Error("storage unavailable")
        },
        removeItem: () => {
          throw new Error("storage unavailable")
        },
      },
    })

    expect(() => markListStale("/enquiries")).not.toThrow()
    expect(consumeListStale("/enquiries")).toBe(false)
  })
})
