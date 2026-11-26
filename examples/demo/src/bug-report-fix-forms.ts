// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"
import { FormLabel } from "@pf/form-schema"

export const reportBugForm = ES.Struct({
  short_description: ES.String.annotate({ [FormLabel]: "Summary" }),
  full_description: ES.String.annotate({ [FormLabel]: "Description" }),
  urgency: ES.String,
})

export const reviewBugForm = ES.Struct({})
