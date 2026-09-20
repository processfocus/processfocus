import {
  Form,
  isCustomEntitiesConfig,
  isOrganisation,
  isPoliciesConfig,
} from "processfocus"
import { TextField } from "processfocus/forms"

const foreign = (await import(
  new URL("../node_modules/processfocus-copy/dist/index.mjs", import.meta.url)
    .href
)) as typeof import("processfocus")

const org = new foreign.Organisation({ name: "Cross-copy fixture" })
const policies = new foreign.PoliciesConfig(org, "Policies", {
  policyFiles: ["cedar/example.cedar"],
})
const customEntities = new foreign.CustomEntitiesConfig(org, "CustomEntities", {
  schemaFiles: ["cedar/example.cedarschema"],
})
const unit = new foreign.OrgUnit(org, "Operations", { name: "Operations" })
const role = new foreign.Role(unit, "Author", { name: "Author" })
const process = new foreign.Process(unit, "Representative", {
  name: "Representative",
  purpose: "Exercise stable authoring brands",
})
const form = new Form(process, "Submit", {
  name: "Submit representative form",
  form: () => ({ summary: TextField({ label: "Summary" }) }),
  role,
})
process.start(form).end()

if (
  !isOrganisation(org) ||
  !isPoliciesConfig(policies) ||
  !isCustomEntitiesConfig(customEntities) ||
  process.forms()[0]?.form !== form ||
  org.formByPath(form.node.path) !== form
) {
  throw new Error("Separately installed SDK copies did not interoperate")
}
