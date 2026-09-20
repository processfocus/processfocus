import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Schema } from "effect"
import { normalizePath, pathToPascalCase, toConstructPath } from "./org-utils"
import { describe, expect, it } from "bun:test"

const PathConversionFixturesSchema = Schema.Array(
  Schema.Struct({ input: Schema.String, expected: Schema.String }),
)

const rawPathConversionFixtures: unknown = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../test-fixtures/path-to-pascal-case.json"),
    "utf8",
  ),
)
const pathConversionFixtures = Schema.decodeUnknownSync(
  PathConversionFixturesSchema,
)(rawPathConversionFixtures)

describe("normalizePath", () => {
  it("should add leading slash to path without one", () => {
    expect(normalizePath("Demo/engineering/bug-fix")).toBe(
      "/Demo/engineering/bug-fix",
    )
  })

  it("should not double-slash path that already has leading slash", () => {
    expect(normalizePath("/Demo/engineering/bug-fix")).toBe(
      "/Demo/engineering/bug-fix",
    )
  })

  it("should handle empty path", () => {
    expect(normalizePath("")).toBe("/")
  })

  it("should handle single segment", () => {
    expect(normalizePath("Demo")).toBe("/Demo")
  })
})

describe("toConstructPath", () => {
  it("should strip leading slash from path", () => {
    expect(toConstructPath("/Demo/engineering/bug-fix")).toBe(
      "Demo/engineering/bug-fix",
    )
  })

  it("should not modify path without leading slash", () => {
    expect(toConstructPath("Demo/engineering/bug-fix")).toBe(
      "Demo/engineering/bug-fix",
    )
  })

  it("should handle path with only slash", () => {
    expect(toConstructPath("/")).toBe("")
  })

  it("should handle single segment with slash", () => {
    expect(toConstructPath("/Demo")).toBe("Demo")
  })
})

describe("pathToPascalCase", () => {
  it("matches the shared path conversion fixtures", () => {
    for (const fixture of pathConversionFixtures) {
      expect(pathToPascalCase(fixture.input)).toBe(fixture.expected)
    }
  })
})
