import { Schema } from "effect"

export const deadlineStartForm = Schema.Struct({ subject: Schema.String })
export const deadlineCompleteForm = Schema.Struct({
  acknowledged: Schema.Boolean,
})
export const deadlineManagerForm = Schema.Struct({
  managerDecision: Schema.String,
})
