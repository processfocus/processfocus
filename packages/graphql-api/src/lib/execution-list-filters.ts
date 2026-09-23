import { Effect } from "effect"
import { InputValidationError } from "@pf/graphql-schema"
import type { ExecutionStatus } from "./rxdb/execution"

export type ExecutionListStatus = ExecutionStatus

const isExecutionListStatus = (status: string): status is ExecutionListStatus =>
  status === "Running" ||
  status === "Completed" ||
  status === "Failed" ||
  status === "Not started" ||
  status === "Abandoned"

export const parseExecutionListStatus = (status: string | null | undefined) =>
  Effect.gen(function* () {
    if (status == null) return undefined
    if (!isExecutionListStatus(status)) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "status",
            message:
              'Status must be "Running", "Completed", "Failed", "Not started", or "Abandoned".',
          },
        ],
      })
    }
    return status
  })
