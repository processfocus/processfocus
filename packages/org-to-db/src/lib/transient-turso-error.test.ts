import { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import {
  isTransientTursoServerError,
  retryTransientTursoServerError,
} from "./transient-turso-error"
import { describe, expect, it } from "bun:test"

describe("isTransientTursoServerError", () => {
  it("matches nested Turso HTTP 502 errors", () => {
    const error = {
      message: "Failed to execute QueryPromise",
      cause: {
        message: "Failed query: insert into pf_role",
        cause: {
          message: "SERVER_ERROR: Server returned HTTP status 502",
          cause: new Error("Server returned HTTP status 502"),
        },
      },
    }

    expect(isTransientTursoServerError(error)).toBe(true)
  })

  it("matches Turso HTTP 502 errors wrapped in SqlError", () => {
    const error = new SqlError({
      message: "Failed to execute QueryPromise",
      cause: new Error("SERVER_ERROR: Server returned HTTP status 502"),
    })

    expect(isTransientTursoServerError(error)).toBe(true)
  })

  it("matches string causes", () => {
    expect(isTransientTursoServerError("Server returned HTTP status 502")).toBe(
      true,
    )
  })

  it("matches numeric HTTP 502 causes", () => {
    expect(
      isTransientTursoServerError({
        message: "Failed to execute QueryPromise",
        cause: {
          status: 502,
        },
      }),
    ).toBe(true)
  })

  it("matches numeric 502 values in cause chains", () => {
    expect(
      isTransientTursoServerError({
        message: "Failed to execute QueryPromise",
        cause: 502,
      }),
    ).toBe(true)
  })

  it("ignores unrelated database errors", () => {
    expect(isTransientTursoServerError(new Error("constraint failed"))).toBe(
      false,
    )
  })

  it("stops scanning circular cause chains", () => {
    const error: { message: string; cause?: unknown } = {
      message: "constraint failed",
    }
    error.cause = error

    expect(isTransientTursoServerError(error)).toBe(false)
  })

  it("matches errors at the maximum scanned cause depth", () => {
    let error: unknown = { message: "Server returned HTTP status 502" }
    for (let index = 0; index < 7; index += 1) {
      error = { message: "wrapped", cause: error }
    }

    expect(isTransientTursoServerError(error)).toBe(true)
  })

  it("stops scanning very deep cause chains", () => {
    let error: unknown = { message: "Server returned HTTP status 502" }
    for (let index = 0; index < 8; index += 1) {
      error = { message: "wrapped", cause: error }
    }

    expect(isTransientTursoServerError(error)).toBe(false)
  })
})

describe("retryTransientTursoServerError", () => {
  it("retries once when a Turso HTTP 502 fails the first attempt", async () => {
    let attempts = 0

    const result = await Effect.runPromise(
      Effect.suspend(() => {
        attempts += 1
        return attempts === 1
          ? Effect.fail({ message: "Server returned HTTP status 502" })
          : Effect.succeed("imported")
      }).pipe(retryTransientTursoServerError),
    )

    expect(result).toBe("imported")
    expect(attempts).toBe(2)
  })

  it("does not retry non-transient failures", async () => {
    let attempts = 0
    let rejected = false

    try {
      await Effect.runPromise(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(new Error("constraint failed"))
        }).pipe(retryTransientTursoServerError),
      )
    } catch {
      rejected = true
    }

    expect(rejected).toBe(true)
    expect(attempts).toBe(1)
  })

  it("stops after two total attempts on persistent Turso HTTP 502 failures", async () => {
    let attempts = 0
    let rejected = false

    try {
      await Effect.runPromise(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail({ message: "Server returned HTTP status 502" })
        }).pipe(retryTransientTursoServerError),
      )
    } catch {
      rejected = true
    }

    expect(rejected).toBe(true)
    expect(attempts).toBe(2)
  })
})
