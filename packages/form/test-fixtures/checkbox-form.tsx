import { Schema } from "effect"
import { createRoot } from "react-dom/client"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import { BooleanField, TextField } from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"

const schema = withFormRules(
  Schema.Struct({
    expected: BooleanField({
      label: "Expected on this day",
      description: "Expect this child on Fridays.",
    }),
    consent: BooleanField({
      label:
        "I confirm that I have read and understood the attendance arrangements for this child on the selected day",
    }),
    disabled: BooleanField({ label: "Disabled preference" }),
    notes: TextField({ label: "Notes" }),
  }),
  () => ({ disabled: { disabled: true } }),
)

const container = document.getElementById("root")
if (!container) throw new Error("Missing fixture root")
createRoot(container).render(
  <main className="mx-auto max-w-xl p-6">
    <EffectSchemaForm
      schema={schema}
      draftId="checkbox-layout"
      defaultValues={{
        expected: false,
        consent: false,
        disabled: true,
        notes: "",
      }}
      onSubmit={async () => undefined}
    >
      {() => <button type="submit">Submit</button>}
    </EffectSchemaForm>
  </main>,
)
