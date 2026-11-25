import { describe, expect, test } from "vitest"
import {
  ListRefreshState,
  parseListReturnDestination,
} from "../app/(protected)/lists/lib/list-refresh"
import type {
  ListDataResult,
  ListQueryVariables,
} from "../lib/graphql/list-queries"

const initial: ListDataResult = {
  items: [{ id: "old" }],
  totalCount: 1,
  page: 1,
  limit: 20,
  hasNextPage: false,
}
const empty: ListDataResult = { ...initial, items: [], totalCount: 0 }
const variables: ListQueryVariables = { page: 1, limit: 20, filter: null }

describe("List submission refresh/history boundary", () => {
  test("cancellation keeps SSR rows; only a remembered same-shell return is warm", async () => {
    const state = new ListRefreshState()
    const token = state.rememberReturn("/lists/things?filter=mine")
    expect(state.canReturn(token, "/lists/things?filter=mine")).toBe(true)
    expect(state.canReturn(token, "/lists/things")).toBe(false)
    expect(
      new ListRefreshState().canReturn(token, "/lists/things?filter=mine"),
    ).toBe(false)
    let requests = 0
    await state.refresh("/things", variables, initial, async () => {
      requests++
      return empty
    })
    expect(requests).toBe(0)
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "ready",
      data: initial,
    })
  })

  test("deduplicates retained-page refreshes and never restores pre-submission membership", async () => {
    const state = new ListRefreshState()
    const serverSnapshot = state.snapshot()
    state.invalidate("/things")
    const pendingSnapshot = state.snapshot()
    expect(pendingSnapshot).not.toBe(serverSnapshot)
    expect(state.snapshot()).toBe(pendingSnapshot)
    let resolve: (data: ListDataResult) => void = () => {
      throw new Error("not started")
    }
    let requests = 0
    const fetch = () => {
      requests++
      return new Promise<ListDataResult>((done) => {
        resolve = done
      })
    }
    const loading = state.refresh("/things", variables, initial, fetch)
    await state.refresh("/things", variables, initial, fetch)
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "loading",
    })
    resolve(empty)
    await loading
    expect(requests).toBe(1)
    expect(state.snapshot()).not.toBe(pendingSnapshot)
    expect(state.read("/things", variables, initial, pendingSnapshot)).toEqual({
      kind: "loading",
    })
    // An older retained page supplies the old SSR payload on Back/Forward.
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "ready",
      data: empty,
    })
    await state.refresh("/things", variables, initial, fetch)
    expect(requests).toBe(1)
    expect(state.read("/other", variables, initial)).toEqual({
      kind: "ready",
      data: initial,
    })
  })

  test("a new server payload revalidates cached rows and history retains the newer membership", async () => {
    const state = new ListRefreshState()
    state.invalidate("/things")
    await state.refresh("/things", variables, initial, async () => empty)
    const newer = { ...initial, items: [{ id: "new" }] }
    let requests = 0
    await state.refresh("/things", variables, newer, async () => {
      requests++
      return newer
    })
    expect(requests).toBe(1)
    expect(state.read("/things", variables, newer)).toEqual({
      kind: "ready",
      data: newer,
    })
    // Back to an older RSC payload must retain the latest confirmed rows.
    await state.refresh("/things", variables, initial, async () => {
      requests++
      return empty
    })
    expect(requests).toBe(1)
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "ready",
      data: newer,
    })
  })

  test("invalidates every filter/sort/page view, keeping their refreshed results separate", async () => {
    const state = new ListRefreshState()
    const filtered = {
      ...variables,
      page: 2,
      filter: "mine",
      sort: { field: "name", direction: "DESC" as const },
    }
    state.invalidate("/things")
    await state.refresh("/things", variables, initial, async () => empty)
    expect(state.read("/things", filtered, initial)).toEqual({
      kind: "loading",
    })
    await state.refresh("/things", filtered, initial, async (query) => {
      expect(query).toEqual(filtered)
      return initial
    })
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "ready",
      data: empty,
    })
    state.invalidate("/things")
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "loading",
    })
    expect(state.read("/things", filtered, initial)).toEqual({
      kind: "loading",
    })
  })

  test("a failed refresh stays retryable without reusing old rows or repeating the mutation", async () => {
    const state = new ListRefreshState()
    state.invalidate("/things")
    await state.refresh("/things", variables, initial, async () => {
      throw new Error("offline")
    })
    expect(state.read("/things", variables, initial)).toEqual({ kind: "error" })
    let requests = 0
    await state.refresh("/things", variables, initial, async () => {
      requests++
      return empty
    })
    expect(requests).toBe(0)
    state.invalidate("/things")
    await state.refresh("/things", variables, initial, async () => empty)
    expect(state.read("/things", variables, initial)).toEqual({
      kind: "ready",
      data: empty,
    })
  })

  test.each(["submission", "server navigation"])(
    "a response racing a later %s cannot replace the latest membership",
    async (change) => {
      const state = new ListRefreshState()
      state.invalidate("/things")
      let resolve: (data: ListDataResult) => void = () => {
        throw new Error("not started")
      }
      const earlier = state.refresh(
        "/things",
        variables,
        initial,
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      if (change === "submission") state.invalidate("/things")
      const nextPayload = change === "submission" ? initial : { ...initial }
      await state.refresh("/things", variables, nextPayload, async () => empty)
      resolve(initial)
      await earlier
      expect(state.read("/things", variables, initial)).toEqual({
        kind: "ready",
        data: empty,
      })
      // A replacement identity/environment gets a new owner, with no retained rows.
      expect(new ListRefreshState().read("/things", variables, empty)).toEqual({
        kind: "ready",
        data: empty,
      })
    },
  )
})

test("return URL parsing preserves encoded navigation and rejects unsafe or malformed destinations", () => {
  const origin = "https://dashboard.example.test"
  expect(
    parseListReturnDestination("/lists/year%20groups?page=2", origin),
  ).toEqual({
    href: "/lists/year%20groups?page=2",
    listPath: "/year groups",
  })
  for (const returnTo of [
    null,
    "https://other.test/lists/things",
    "/lists/../processes",
    "/lists/a%E0%A4%A",
  ]) {
    expect(parseListReturnDestination(returnTo, origin)).toBeNull()
  }
})
