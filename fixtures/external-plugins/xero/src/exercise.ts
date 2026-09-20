import {
  XeroInvoice,
  XeroInvoiceStep,
  decodeIssueAuthorisedSalesInvoiceInput,
} from "@processfocus/plugin-xero"
import { XeroInvoiceLive } from "@processfocus/plugin-xero/runtime"
import { makeXeroInvoiceTestPlugin } from "@processfocus/plugin-xero/testing"
import { OrgUnit, Organisation, Process } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const unit = new OrgUnit(org, "Operations", { name: "Operations" })
const process = new Process(unit, "Invoice", {
  name: "Invoice",
  purpose: "Exercise the Xero plugin public surfaces",
})

const step = new XeroInvoiceStep(process, "Create Xero Invoice", {
  input: () =>
    decodeIssueAuthorisedSalesInvoiceInput({
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
    }),
})

const plugin = makeXeroInvoiceTestPlugin()
if (
  !step.isSystemStep ||
  XeroInvoice.key.length === 0 ||
  XeroInvoiceLive === undefined ||
  typeof plugin.controller.clear !== "function"
) {
  throw new Error("Xero plugin public surfaces failed")
}
