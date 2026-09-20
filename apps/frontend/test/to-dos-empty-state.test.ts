import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const toDosPageSource = readFileSync(
  join(import.meta.dir, "../app/(protected)/to-dos/page.tsx"),
  "utf8",
)

describe("to-dos empty state", () => {
  test("does not include the placeholder illustration phrase", () => {
    expect(toDosPageSource).not.toContain("Empty state illustration")
    expect(toDosPageSource).not.toContain("illustrations.popsy.co")
  })

  test("keeps the no-matching-filters empty-state copy", () => {
    expect(toDosPageSource).toContain('title="No todos match these filters"')
    expect(toDosPageSource).toContain(
      "Try expanding your filters or check the Processes catalog to kick off new work.",
    )
  })
})
