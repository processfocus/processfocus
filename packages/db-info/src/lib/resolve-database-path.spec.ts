import { resolve } from "node:path"
import { ConfigProvider, Effect } from "effect"
import {
  DatabasePathConfig,
  resolveDatabasePath,
} from "./resolve-database-path"
import { describe, expect, it } from "bun:test"

describe("resolveDatabasePath", () => {
  it("prefers SQLITE_DATABASE_PATH over PF_ORG", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    const originalPfOrg = process.env["PF_ORG"]
    try {
      process.env["SQLITE_DATABASE_PATH"] = "/explicit/path.db"
      process.env["PF_ORG"] = "examples/demo"
      expect(resolveDatabasePath()).toBe("/explicit/path.db")
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
      if (originalPfOrg !== undefined) process.env["PF_ORG"] = originalPfOrg
      else delete process.env["PF_ORG"]
    }
  })

  it("prefers SQLITE_DATABASE_PATH over orgPath argument", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    try {
      process.env["SQLITE_DATABASE_PATH"] = "/explicit/path.db"
      expect(resolveDatabasePath("examples/demo")).toBe("/explicit/path.db")
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
    }
  })

  it("falls back to orgPath/db/pf.db when SQLITE_DATABASE_PATH unset", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    try {
      delete process.env["SQLITE_DATABASE_PATH"]
      const result = resolveDatabasePath("examples/demo")
      expect(result).toBe(resolve("examples/demo", "db", "pf.db"))
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
    }
  })

  it("falls back to PF_ORG/db/pf.db when SQLITE_DATABASE_PATH unset and no orgPath", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    const originalPfOrg = process.env["PF_ORG"]
    try {
      delete process.env["SQLITE_DATABASE_PATH"]
      process.env["PF_ORG"] = "examples/demo"
      const result = resolveDatabasePath()
      expect(result).toBe(resolve("examples/demo", "db", "pf.db"))
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
      if (originalPfOrg !== undefined) process.env["PF_ORG"] = originalPfOrg
      else delete process.env["PF_ORG"]
    }
  })

  it("resolves relative paths to absolute", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    try {
      delete process.env["SQLITE_DATABASE_PATH"]
      const result = resolveDatabasePath("examples/demo")
      expect(result).toMatch(/^\//)
      expect(result).toEndWith("/examples/demo/db/pf.db")
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
    }
  })

  it("handles absolute orgPath", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    try {
      delete process.env["SQLITE_DATABASE_PATH"]
      const result = resolveDatabasePath("/tmp/org")
      expect(result).toBe("/tmp/org/db/pf.db")
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
    }
  })

  it("returns undefined when neither source is available", () => {
    const original = process.env["SQLITE_DATABASE_PATH"]
    const originalPfOrg = process.env["PF_ORG"]
    try {
      delete process.env["SQLITE_DATABASE_PATH"]
      delete process.env["PF_ORG"]
      expect(resolveDatabasePath()).toBeUndefined()
    } finally {
      if (original !== undefined) process.env["SQLITE_DATABASE_PATH"] = original
      else delete process.env["SQLITE_DATABASE_PATH"]
      if (originalPfOrg !== undefined) process.env["PF_ORG"] = originalPfOrg
      else delete process.env["PF_ORG"]
    }
  })
})

describe("DatabasePathConfig", () => {
  it("prefers SQLITE_DATABASE_PATH over PF_ORG", async () => {
    const result = await Effect.runPromise(
      DatabasePathConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["SQLITE_DATABASE_PATH", "/explicit/path.db"],
              ["PF_ORG", "examples/demo"],
            ]),
          ),
        ),
      ),
    )
    expect(result).toBe("/explicit/path.db")
  })

  it("falls back to PF_ORG when SQLITE_DATABASE_PATH unset", async () => {
    const result = await Effect.runPromise(
      DatabasePathConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PF_ORG", "/tmp/my-org"]])),
        ),
      ),
    )
    expect(result).toBe("/tmp/my-org/db/pf.db")
  })

  it("resolves relative PF_ORG paths to absolute", async () => {
    const result = await Effect.runPromise(
      DatabasePathConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PF_ORG", "examples/demo"]])),
        ),
      ),
    )
    expect(result).toMatch(/^\//)
    expect(result).toEndWith("/examples/demo/db/pf.db")
  })

  it("fails when neither is set", async () => {
    const result = await Effect.runPromiseExit(
      DatabasePathConfig.pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
      ),
    )
    expect(result._tag).toBe("Failure")
  })
})
