import { Schema } from "effect"
import {
  BooleanField,
  LookupField,
  NumberFieldFrom,
  NumberFromString,
  TextField,
  TextFieldFrom,
  Wrapper,
} from "@pf/form-schema"

/** Public executable definition; database checks belong in purchase-request.ts. */
export const purchaseRequestForm = Schema.Struct({
  referenceOrderId: Schema.optional(
    LookupField({
      label: "Reference purchase order",
      mode: "server",
    }),
  ),
  request: Wrapper({
    item: TextFieldFrom(
      Schema.Trim.check(
        Schema.isMinLength(1, { message: "Enter an item to purchase" }),
      ),
      { label: "Item" },
    ),
    value: NumberFieldFrom(
      NumberFromString.check(
        Schema.isGreaterThan(0, { message: "Value must be greater than zero" }),
      ),
      { label: "Value" },
    ),
  }),
})

export const purchaseApprovalForm = Schema.Struct({
  item: TextField({ label: "Item to approve", readOnly: true }),
  cost: TextField({ label: "Cost", readOnly: true }),
  check: BooleanField({ label: "I approve", required: true }),
})
