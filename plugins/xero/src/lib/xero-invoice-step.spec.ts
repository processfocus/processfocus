import { makeXeroInvoiceTestPlugin } from "@processfocus/plugin-xero/test-support"
import { Effect, Schema } from "effect"
import {
  CurrentStepJobContext,
  OrgUnit,
  Organisation,
  Process,
} from "@pf/process"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { XeroInvoiceStep } from "./xero-invoice-step"
import { describe, expect, it } from "bun:test"

const sampleInput = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: {
    line1: "10 Customhouse Quay",
    city: "Wellington",
  },
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
})

describe("XeroInvoiceStep", () => {
  const org = new Organisation({ name: "TestOrg" })
  const unit = new OrgUnit(org, "test-unit", { name: "Test Unit" })

  it("is a system step with invoice identity output", () => {
    const process = new Process(unit, "NewOrder", {
      name: "New Order",
      purpose: "Testing XeroInvoiceStep",
    })
    const step = new XeroInvoiceStep(process, "Create Xero Invoice", {
      input: () => Effect.succeed(sampleInput),
    })

    expect(step.isSystemStep).toBe(true)
    expect(step.output.invoiceId).toBe(Schema.String)
    expect(step.output.invoiceNumber).toBe(Schema.String)
  })

  it("issues an authorised invoice through the Effect interface", async () => {
    const process = new Process(unit, "NewOrderExecute", {
      name: "New Order",
      purpose: "Testing execute",
    })
    const step = new XeroInvoiceStep(process, "Create Xero Invoice", {
      input: () => Effect.succeed(sampleInput),
    })
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedItem({
      itemCode: "TBS-100",
      name: "TBS Product",
      taxType: "NONE",
      taxPercent: 0,
    })

    const result = await Effect.runPromise(
      step.execute(sampleInput).pipe(
        Effect.provide(plugin.layer),
        Effect.provideService(CurrentStepJobContext, {
          todoId: "todo-01JTESTXEROSTEP0000000001",
          stepPath: "/Create Xero Invoice",
        }),
      ),
    )

    expect(result.invoiceNumber).toBe("INV-0001")
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })
})
