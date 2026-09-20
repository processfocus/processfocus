import { AwsFunctionStep } from "@processfocus/plugin-aws-lambda"
import { Effect, Schema } from "effect"
import { OrgUnit, Organisation, Process } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const unit = new OrgUnit(org, "Operations", { name: "Operations" })
const process = new Process(unit, "Lambda", {
  name: "Lambda",
  purpose: "Exercise the AWS Lambda plugin authoring surface",
})

const step = new AwsFunctionStep(process, "Add", {
  functionName: "demo-add-numbers",
  input: () => Effect.succeed({ a: 1, b: 2 }),
  output: { result: Schema.Number },
})

if (!step.functionName || !step.isSystemStep) {
  throw new Error("AWS Lambda plugin authoring surface failed")
}
