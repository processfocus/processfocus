import { Schema } from "effect"
import { EmailField } from "./email"

/** System-owned correction has its own authorization and submission operation. */
export const publicCompletionCorrectionForm = Schema.Struct({
  correctedEmail: EmailField({ label: "Corrected email" }),
})
