// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"
import { BooleanField } from "@pf/form-schema"

export const procurementApprovalForm = ES.Struct({
  check: BooleanField({
    label: "LGTM",
    required: true,
  }),
})

export const purchaseForm = ES.Struct({
  completed: BooleanField({
    label: "I confirm the purchase has been made",
  }),
})
