import { Effect } from "effect"
import { InputValidationError } from "@pf/graphql-schema"

export const validateProcessListStatus = (status: string | null | undefined) =>
  Effect.gen(function* () {
    if (status == null || status === "Active") return

    return yield* new InputValidationError({
      errors: [
        {
          field: "status",
          message: 'Status must be "Active".',
        },
      ],
    })
  })
