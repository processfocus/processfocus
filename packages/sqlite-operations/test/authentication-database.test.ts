import {
  isSqliteBusy,
  isTransientSqliteError,
} from "../src/lib/authentication-database.js"
import { describe, expect, it } from "bun:test"

describe("isSqliteBusy", () => {
  it("matches wrapped busy errors through their cause chain", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: new Error("SQLITE_BUSY: database is locked"),
    }

    expect(isSqliteBusy(error)).toBe(true)
  })

  it("matches direct busy errors", () => {
    expect(isSqliteBusy(new Error("database is locked"))).toBe(true)
  })

  it("ignores unrelated errors", () => {
    expect(isSqliteBusy(new Error("constraint failed"))).toBe(false)
  })

  it("does not match Turso socket closures", () => {
    expect(
      isSqliteBusy(new Error("The socket connection was closed unexpectedly")),
    ).toBe(false)
  })

  it("does not match nested ECONNRESET cause codes", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: { code: "ECONNRESET" },
    }

    expect(isSqliteBusy(error)).toBe(false)
  })
})

describe("isTransientSqliteError", () => {
  it("matches wrapped Turso socket closures through their cause chain", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: new Error("The socket connection was closed unexpectedly"),
    }

    expect(isTransientSqliteError(error)).toBe(true)
  })

  it("matches busy errors", () => {
    expect(isTransientSqliteError(new Error("database is locked"))).toBe(true)
  })

  it("matches direct SQLITE_BUSY errors", () => {
    expect(isTransientSqliteError(new Error("SQLITE_BUSY"))).toBe(true)
  })

  it("matches string causes", () => {
    expect(
      isTransientSqliteError("The socket connection was closed unexpectedly"),
    ).toBe(true)
  })

  it("matches nested ECONNRESET cause codes", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: {
        query: "select * from pf_process",
        cause: {
          code: "ECONNRESET",
          path: "https://database.turso.io/v2/pipeline",
          errno: 0,
        },
      },
    }

    expect(isTransientSqliteError(error)).toBe(true)
  })

  it("ignores unrelated errors", () => {
    expect(isTransientSqliteError(new Error("constraint failed"))).toBe(false)
  })

  it("stops scanning circular cause chains", () => {
    const error: { message: string; cause?: unknown } = {
      message: "constraint failed",
    }
    error.cause = error

    expect(isTransientSqliteError(error)).toBe(false)
  })
})
