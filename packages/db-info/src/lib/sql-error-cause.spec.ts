import {
  causeChainIncludes,
  isSqlLockError,
  isSqlWriteWriteConflictError,
} from "./sql-error-cause"
import { describe, expect, it } from "bun:test"

describe("causeChainIncludes", () => {
  it("matches nested Error.cause messages", () => {
    const error = new Error("wrapper", {
      cause: new Error("SQLITE_BUSY: database is locked"),
    })

    expect(
      causeChainIncludes(error, (message) => message.includes("SQLITE_BUSY")),
    ).toBe(true)
  })

  it("matches plain object cause chains", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: { message: "database is locked" },
    }

    expect(
      causeChainIncludes(error, (message) =>
        message.includes("database is locked"),
      ),
    ).toBe(true)
  })

  it("matches string causes", () => {
    expect(
      causeChainIncludes("SQLITE_BUSY", (message) =>
        message.includes("SQLITE_BUSY"),
      ),
    ).toBe(true)
  })

  it("matches nested cause codes when codePredicate is provided", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: { code: "ECONNRESET" },
    }

    expect(
      causeChainIncludes(error, () => false, {
        codePredicate: (code) => code === "ECONNRESET",
      }),
    ).toBe(true)
  })

  it("stops scanning circular Error cause chains", () => {
    const error = new Error("constraint failed")
    // Intentionally create a cycle that naive walkers would loop forever.
    ;(error as { cause: unknown }).cause = error

    expect(
      causeChainIncludes(error, (message) => message.includes("SQLITE_BUSY")),
    ).toBe(false)
  })

  it("stops scanning circular plain-object cause chains", () => {
    const error: { message: string; cause?: unknown } = {
      message: "constraint failed",
    }
    error.cause = error

    expect(
      causeChainIncludes(error, (message) => message.includes("SQLITE_BUSY")),
    ).toBe(false)
  })

  it("respects maxDepth", () => {
    const deep = {
      message: "outer",
      cause: {
        message: "middle",
        cause: { message: "SQLITE_BUSY" },
      },
    }

    expect(
      causeChainIncludes(deep, (message) => message.includes("SQLITE_BUSY"), {
        maxDepth: 2,
      }),
    ).toBe(false)
    expect(
      causeChainIncludes(deep, (message) => message.includes("SQLITE_BUSY"), {
        maxDepth: 3,
      }),
    ).toBe(true)
  })
})

describe("isSqlLockError", () => {
  it("matches SQLITE_BUSY", () => {
    expect(isSqlLockError(new Error("SQLITE_BUSY"))).toBe(true)
  })

  it("matches SQLITE_LOCKED", () => {
    expect(isSqlLockError(new Error("SQLITE_LOCKED"))).toBe(true)
  })

  it("matches database is locked", () => {
    expect(isSqlLockError(new Error("database is locked"))).toBe(true)
  })

  it("matches CONCURRENT write conflicts", () => {
    expect(isSqlLockError(new Error("CONCURRENT write conflict"))).toBe(true)
  })

  it("matches TursoDB write-write conflicts", () => {
    expect(
      isSqlLockError(new Error("Tursodb error: Write-write conflict")),
    ).toBe(true)
  })

  it("matches write-write conflicts regardless of casing", () => {
    expect(
      isSqlLockError(new Error("TursoDB error: WRITE-WRITE CONFLICT")),
    ).toBe(true)
    expect(isSqlLockError(new Error("Concurrent write conflict"))).toBe(true)
  })

  it("does not match unrelated concurrent transaction failures", () => {
    expect(
      isSqlLockError(
        new Error("BEGIN CONCURRENT is unsupported for this database"),
      ),
    ).toBe(false)
    expect(isSqlLockError(new Error("Concurrent request limit exceeded"))).toBe(
      false,
    )
  })

  it("matches nested lock errors", () => {
    const error = {
      message: "Failed to execute statement",
      cause: new Error("SQLITE_BUSY: database is locked"),
    }

    expect(isSqlLockError(error)).toBe(true)
  })

  it("matches code-only lock errors", () => {
    const error = {
      message: "Failed to execute statement",
      cause: { code: "SQLITE_BUSY" },
    }

    expect(isSqlLockError(error)).toBe(true)
  })

  it("ignores unrelated errors", () => {
    expect(isSqlLockError(new Error("constraint failed"))).toBe(false)
  })

  it("does not match Turso socket closures", () => {
    expect(
      isSqlLockError(
        new Error("The socket connection was closed unexpectedly"),
      ),
    ).toBe(false)
  })

  it("stops on circular cause chains without matching", () => {
    const error: { message: string; cause?: unknown } = {
      message: "constraint failed",
    }
    error.cause = error

    expect(isSqlLockError(error)).toBe(false)
  })
})

describe("isSqlWriteWriteConflictError", () => {
  it("matches TursoDB write-write conflicts through nested causes", () => {
    expect(
      isSqlWriteWriteConflictError({
        message: "Failed to commit transaction",
        cause: new Error("Tursodb error: Write-write conflict"),
      }),
    ).toBe(true)
  })

  it("does not match ordinary SQLITE_BUSY locks", () => {
    expect(
      isSqlWriteWriteConflictError(
        new Error("SQLITE_BUSY: database is locked"),
      ),
    ).toBe(false)
  })
})
