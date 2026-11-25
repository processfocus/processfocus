import { Schema } from "effect"
import { TextField } from "processfocus/forms"

export const representativeForm = Schema.Struct({
  summary: TextField({ label: "Summary" }),
  display: TextField({ readOnly: true }),
})
