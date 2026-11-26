// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"
import { BooleanField } from "@pf/form-schema"

export const submitTimeOffRequestForm = ES.Struct({
  dates: ES.String,
})

export const approveTimeOffForm = ES.Struct({
  approved: BooleanField({ label: "I approve", required: true }),
})

export const notifyEmployeeForm = ES.Struct({})
