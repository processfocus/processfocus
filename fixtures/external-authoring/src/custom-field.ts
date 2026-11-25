import { Schema } from "effect"
import { FormComponentPluginType, TextFieldFrom } from "processfocus/forms"

export const fixtureForm = Schema.Struct({
  summary: TextFieldFrom(
    Schema.Trim.check(
      Schema.isMinLength(3, { message: "Use at least three characters" }),
    ),
    { label: "Summary" },
  ).annotate({
    [FormComponentPluginType]: {
      module: "./src/custom-field-client.tsx",
      type: "fixture-custom-field",
    },
  }),
})
