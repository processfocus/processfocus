import { Schema } from "effect"
import { Form, Organisation, Process, Role } from "@pf/process"

export const org = new Organisation({ name: "Artifact roundtrip" })
export const Configuration = { version: 1, groups: [] }
const role = new Role(org, "Employee")
const process = new Process(org, "Work", {
  name: "Work",
  purpose: "Artifact acceptance",
})
const fields = () => ({
  name: Schema.String,
  accepted: Schema.Boolean,
  date: Schema.DateTimeUtcFromString,
})
const submit = new Form(process, "Submit", { role, form: fields })
const review = new Form(process, "Review", { role, form: fields })
process.start(submit).next(review).end()
