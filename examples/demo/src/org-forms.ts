// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"
import { FormReadOnly } from "@pf/form-schema"

export const purchaseOrdersForm = ES.Struct({
  id: ES.String.annotate({ title: "ID", [FormReadOnly]: true }),
  item: ES.String.annotate({ title: "Item" }),
  price: ES.Number.annotate({ title: "Price" }),
})
