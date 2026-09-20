import { Effect } from "effect"
import { InputValidationError } from "@pf/graphql-schema"
import { parseTodoListStatusPredicate } from "../src/lib/todo-list-filters"
import { describe, expect, it } from "bun:test"

describe("parseTodoListStatusPredicate", () => {
  it("maps public Todo statuses to storage predicates", async () => {
    await expect(
      Effect.runPromise(parseTodoListStatusPredicate("Active")),
    ).resolves.toEqual({ kind: "correction-free", deleted: false })
    await expect(
      Effect.runPromise(parseTodoListStatusPredicate("Completed")),
    ).resolves.toEqual({ kind: "correction-free", deleted: true })
    await expect(
      Effect.runPromise(parseTodoListStatusPredicate("Correction Required")),
    ).resolves.toEqual({ kind: "correction-required" })
    await expect(
      Effect.runPromise(parseTodoListStatusPredicate(undefined)),
    ).resolves.toBeUndefined()
  })

  it("rejects unsupported status values at the GraphQL boundary", async () => {
    const error = await Effect.runPromise(
      parseTodoListStatusPredicate("Actve").pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(InputValidationError)
    expect(error.message).toContain("status")
  })
})
