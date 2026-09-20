import { Effect } from "effect"
import type { TodoListStatePredicate, TodoRow } from "@pf/graphql-db-operations"
import { InputValidationError } from "@pf/graphql-schema"

type TodoListStatus = TodoRow["status"]

const STATUS_PREDICATES = {
  Active: { kind: "correction-free", deleted: false },
  Completed: { kind: "correction-free", deleted: true },
  "Correction Required": { kind: "correction-required" },
} as const satisfies Record<TodoListStatus, TodoListStatePredicate>

const isTodoListStatus = (status: string): status is TodoListStatus =>
  status === "Active" ||
  status === "Completed" ||
  status === "Correction Required"

export const parseTodoListStatusPredicate = (
  status: string | null | undefined,
) =>
  Effect.gen(function* () {
    if (status == null) return undefined
    if (!isTodoListStatus(status)) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "status",
            message:
              'Status must be "Active", "Completed", or "Correction Required".',
          },
        ],
      })
    }
    return STATUS_PREDICATES[status]
  })
