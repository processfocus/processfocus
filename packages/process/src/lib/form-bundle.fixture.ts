import { Effect, Schema } from "effect"
import { TextField } from "@pf/form-schema"
import { Form } from "./form"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"

export const org = new Organisation({ name: "Bundled" })
const unit = new OrgUnit(org, "unit", { name: "Unit", type: "department" })
const role = new Role(unit, "member", { name: "Member" })
const process = new Process(unit, "process", {
  name: "Process",
  purpose: "test",
})
export const form = new Form(process, "submit", {
  role,
  forEach: { items: () => Effect.succeed([{ name: "actual item" }]) },
  form: ({ value }) => ({
    name: TextField({
      default: value(
        (_state, ctx, item) => `${ctx.process.executionId}:${item.name}`,
      ),
    }),
    accepted: Schema.Boolean,
  }),
})
process.start(form).end()
