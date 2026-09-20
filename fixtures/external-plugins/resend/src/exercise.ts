import { ResendClient, ResendStep } from "@processfocus/plugin-resend"
import { ResendClientLive } from "@processfocus/plugin-resend/runtime"
import { makeMockResendPlugin } from "@processfocus/plugin-resend/testing"
import { Effect } from "effect"
import { OrgUnit, Organisation, Process } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const unit = new OrgUnit(org, "Operations", { name: "Operations" })
const process = new Process(unit, "Email", {
  name: "Email",
  purpose: "Exercise the Resend plugin public surfaces",
})

const step = new ResendStep(process, "Send", {
  from: "Fixture <noreply@example.com>",
  input: () =>
    Effect.succeed({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    }),
})

const mock = makeMockResendPlugin({ environment: "fixture" })
if (
  !step.from ||
  ResendClient.key.length === 0 ||
  ResendClientLive === undefined ||
  typeof mock.controller.clear !== "function"
) {
  throw new Error("Resend plugin public surfaces failed")
}
