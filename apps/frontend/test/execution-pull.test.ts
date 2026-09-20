import { afterEach, describe, expect, it, vi } from "vitest"
import { pullQueryBuilder } from "../lib/collections/execution"

afterEach(() => vi.restoreAllMocks())

describe("execution pull", () => {
  it("includes old Running work only before a stored checkpoint exists", () => {
    const now = Date.parse("2026-09-07T00:00:00Z")
    vi.spyOn(Date, "now").mockReturnValue(now)
    const historySince = now - 5 * 7 * 24 * 60 * 60 * 1000
    expect(pullQueryBuilder(undefined, 50).variables).toEqual({
      checkpoint: { id: "", updatedAt: historySince },
      limit: 50,
      includeRunning: true,
      historySince,
    })
    const checkpoint = { id: "old-running", updatedAt: 100 }
    expect(pullQueryBuilder(checkpoint, 50).variables).toEqual({
      checkpoint,
      limit: 50,
      includeRunning: false,
      historySince,
    })
  })
})
