import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

describe("list page Suspense streaming", () => {
  test("keys the data boundary by list path only", () => {
    // Structural guard only: the runtime smoke test covers the visible flicker
    // behavior, while this prevents reintroducing URL-state key remounts.
    const source = readFileSync(
      new URL(
        "../app/(protected)/lists/[...listPath]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    )

    const dataBoundary = source.match(
      /<Suspense[^>]*fallback={<ListDataSkeleton \/>}[^>]*>/,
    )

    expect(dataBoundary?.[0]).toBe(
      "<Suspense key={listPath} fallback={<ListDataSkeleton />}>",
    )
    expect(dataBoundary?.[0]).not.toContain("page")
    expect(dataBoundary?.[0]).not.toContain("filter")
    expect(dataBoundary?.[0]).not.toContain("sort")
    expect(dataBoundary?.[0]).not.toContain("dir")
  })
})
