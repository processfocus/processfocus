import * as authored from "../index"
import * as runtime from "../runtime"
import * as testSupport from "../test-support"
import { describe, expect, it } from "bun:test"

describe("Xero plugin export seams", () => {
  it("keeps the authored surface to the invoice step and identities", () => {
    expect("XeroInvoiceStep" in authored).toBe(true)
    expect("XeroInvoice" in authored).toBe(true)
    expect("XeroInvoiceLookup" in authored).toBe(true)
    expect("XeroDraftInvoice" in authored).toBe(true)
    expect("XeroDraftInvoiceLive" in authored).toBe(false)
    expect("XeroInvoiceLookupLive" in authored).toBe(false)
    expect("XeroInvoiceLive" in authored).toBe(false)
    expect("makeXeroInvoiceTestPlugin" in authored).toBe(false)
  })

  it("exports the live Layer from runtime only", () => {
    expect("XeroInvoiceLive" in runtime).toBe(true)
    expect("XeroInvoiceLookupLive" in runtime).toBe(true)
    expect("XeroDraftInvoiceLive" in runtime).toBe(true)
    expect("XeroInvoiceConfigFromEnv" in runtime).toBe(true)
    expect("xeroInvoiceWritePayload" in runtime).toBe(false)
    expect("xeroContactWritePayload" in runtime).toBe(false)
    expect("makeXeroInvoiceTestPlugin" in runtime).toBe(false)
    expect("XeroInvoiceStep" in runtime).toBe(false)
  })

  it("keeps the stateful test Layer behind test-support", () => {
    expect(typeof testSupport.makeXeroInvoiceTestPlugin).toBe("function")
  })
})
