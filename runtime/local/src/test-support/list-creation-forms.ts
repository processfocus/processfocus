import { Schema } from "effect"
import {
  EmailField,
  FormDateInput,
  FormDefault,
  TextField,
} from "@pf/form-schema"
export const fields = {
  name: TextField({ label: "Name" }).pipe(Schema.check(Schema.isMinLength(1))),
  email: EmailField({ label: "Email" }),
  date: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)),
  ).annotate({ title: "Date", [FormDateInput]: true }),
  category: Schema.Literals(["Member", "Guest"]).annotate({
    title: "Category",
    [FormDefault]: "Member",
  }),
}

export const contactCreateForm = Schema.Struct({
  ...fields,
  summary: TextField({ label: "Summary", readOnly: true }),
})
export const contactEditForm = Schema.Struct({
  ...fields,
  id: TextField({ label: "ID", readOnly: true }),
  summary: TextField({ label: "Summary", readOnly: true }),
})
