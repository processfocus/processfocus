import { ResendClient, ResendStep } from "@processfocus/plugin-resend"
import { ResendClientLive } from "@processfocus/plugin-resend/runtime"
import { makeMockResendPlugin } from "@processfocus/plugin-resend/testing"
import { EmailSender, NotificationDeliveryConfig } from "@processfocus/runtime"
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

await Effect.runPromise(
  Effect.gen(function* () {
    const config = yield* NotificationDeliveryConfig
    const sender = yield* EmailSender
    const message = {
      to: "user@example.com",
      from: "noreply@example.com",
      subject: "Packed notification",
      html: "<p>Hi</p>",
    }
    const receipt = yield* sender.send(message, {
      idempotencyKey: "packed-notification",
    })
    if (
      config.getEnvironment() !== "fixture" ||
      !receipt?.providerMessageId ||
      receipt.providerSentTo !== message.to ||
      mock.controller.listSentMessages()[0]?.originalRequest.idempotencyKey !==
        "packed-notification" ||
      mock.controller.listSentMessages().length !== 1
    )
      throw new Error("Packed runtime notification contract failed")
  }).pipe(Effect.provide(mock.layer)),
)
