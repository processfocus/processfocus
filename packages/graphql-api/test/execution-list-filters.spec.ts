import { Effect } from "effect"
import { InputValidationError } from "@pf/graphql-schema"
import {
  type ExecutionListStatus,
  parseExecutionListStatus,
} from "../src/lib/execution-list-filters"
import { describe, expect, it } from "bun:test"

describe("parseExecutionListStatus", () => {
  it("accepts public Execution statuses", async () => {
    const statuses = [
      "Running",
      "Completed",
      "Failed",
      "Abandoned",
    ] satisfies readonly ExecutionListStatus[]

    for (const status of statuses) {
      await expect(
        Effect.runPromise(parseExecutionListStatus(status)),
      ).resolves.toBe(status)
    }
    await expect(
      Effect.runPromise(parseExecutionListStatus(undefined)),
    ).resolves.toBeUndefined()
  })

  it("rejects unsupported status values at the GraphQL boundary", async () => {
    const error = await Effect.runPromise(
      parseExecutionListStatus("InProgress").pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(InputValidationError)
    expect(error.message).toContain("status")
  })
})
