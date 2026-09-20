import { rxDbMasterStatesMatch } from "../src/lib/rxdb/resolver-makers"
import { describe, expect, it } from "bun:test"

describe("RxDB push conflict detection", () => {
  const current = {
    id: "draft-1",
    updatedAt: 1_000,
    deleted: false,
  }

  it("accepts the current master version", () => {
    expect(rxDbMasterStatesMatch(current, current)).toBe(true)
  })

  it("rejects stale, deleted, and mismatched master versions", () => {
    expect(rxDbMasterStatesMatch(current, { ...current, updatedAt: 999 })).toBe(
      false,
    )
    expect(rxDbMasterStatesMatch(current, { ...current, deleted: true })).toBe(
      false,
    )
    expect(rxDbMasterStatesMatch(current, { ...current, id: "draft-2" })).toBe(
      false,
    )
  })
})
