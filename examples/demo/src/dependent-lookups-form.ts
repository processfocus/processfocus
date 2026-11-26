import { Schema } from "effect"
import { LookupField } from "@pf/form-schema"

export const dependentLookupsForm = Schema.Struct({
  region: LookupField({ label: "Region", mode: "local", maxItems: 2 }),
  depot: LookupField({ label: "Depot", mode: "local", maxItems: 30 }),
  recipient: LookupField({ label: "Recipient", mode: "server" }),
})
