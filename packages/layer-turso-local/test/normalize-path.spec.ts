import {
  isLocalFilePath,
  normalizeDatabasePath,
  toTursoDatabasePath,
} from "../src/index"
import { describe, expect, it } from "bun:test"

describe("Turso database path helpers", () => {
  it("normalizes bare paths as file URLs", () => {
    expect(normalizeDatabasePath("./data/pf.db")).toBe("file://./data/pf.db")
  })

  it("preserves explicit protocols", () => {
    expect(normalizeDatabasePath("file:./data/pf.db")).toBe("file:./data/pf.db")
  })

  it("detects local file paths", () => {
    expect(isLocalFilePath("./data/pf.db")).toBe(true)
    expect(isLocalFilePath("file:./data/pf.db")).toBe(true)
    expect(isLocalFilePath("libsql://example.turso.io")).toBe(false)
  })

  it("converts file URLs to Turso SDK paths", () => {
    expect(toTursoDatabasePath("file://./data/pf.db")).toBe("./data/pf.db")
    expect(toTursoDatabasePath("file:./data/pf.db")).toBe("./data/pf.db")
  })
})
