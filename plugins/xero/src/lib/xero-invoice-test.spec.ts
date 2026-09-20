import { Effect, Logger, Schema } from "effect"
import { CurrentStepJobContext } from "@pf/process"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import {
  XeroInvoice,
  decodeIssueAuthorisedSalesInvoiceInput,
} from "./xero-invoice"
import { makeXeroInvoiceTestPlugin } from "./xero-invoice-test"
import { describe, expect, it } from "bun:test"

const INVOICE_TODO = {
  todoId: "todo-01JTESTXEROINVOICE00000001",
  stepPath: "/Create Xero Invoice",
} as const

const sampleInput = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  shippingAddress: {
    line1: "10 Customhouse Quay",
    city: "Wellington",
    postalCode: "6011",
    country: "New Zealand",
  },
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
})

const issue = (
  layer: ReturnType<typeof makeXeroInvoiceTestPlugin>["layer"],
  input: typeof sampleInput = sampleInput,
  todoId: string = INVOICE_TODO.todoId,
) =>
  Effect.gen(function* () {
    const xero = yield* XeroInvoice
    return yield* xero.issueAuthorisedSalesInvoice(input)
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(CurrentStepJobContext, {
      todoId,
      stepPath: INVOICE_TODO.stepPath,
    }),
  )

const seedCatalogItem = (
  plugin: ReturnType<typeof makeXeroInvoiceTestPlugin>,
) => {
  plugin.controller.seedItem({
    itemCode: "TBS-100",
    name: "TBS Product",
    taxType: "NONE",
    taxPercent: 0,
  })
}

describe("XeroInvoice test Layer", () => {
  it("exposes one invoice operation", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    const keys = await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        return Object.keys(xero)
      }).pipe(
        Effect.provide(plugin.layer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
      ),
    )

    expect(keys).toEqual(["issueAuthorisedSalesInvoice"])
  })

  it("can seed duplicate normalized emails, duplicate names, and postal addresses", () => {
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
      addresses: [
        {
          addressType: "STREET",
          line1: "1 Street",
          city: "Wellington",
        },
      ],
    })
    plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: " ADA@example.com ",
      addresses: [
        {
          addressType: "POBOX",
          line1: "PO Box 12",
          city: "Wellington",
        },
      ],
    })

    // One normalized email may correspond to multiple Xero contacts.
    expect(
      plugin.controller.findContactByEmail("ada@example.com"),
    ).toHaveLength(2)
    expect(plugin.controller.findContactByName("Ada Lovelace")).toHaveLength(2)
    expect(plugin.controller.listContacts()[1]?.addresses[0]?.addressType).toBe(
      "POBOX",
    )
  })

  it("creates a contact when no email match exists", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)

    const result = await Effect.runPromise(issue(plugin.layer))
    const contacts = plugin.controller.listContacts()
    const invoices = plugin.controller.listInvoices()

    expect(contacts).toHaveLength(1)
    expect(contacts[0]?.email).toBe("ada@example.com")
    expect(contacts[0]?.name).toBe("Ada Lovelace")
    expect(contacts[0]?.addresses).toEqual([
      {
        addressType: "STREET",
        line1: "10 Customhouse Quay",
        city: "Wellington",
        postalCode: "6011",
        country: "New Zealand",
      },
    ])
    expect(invoices).toHaveLength(1)
    expect(invoices[0]?.contactId).toBe(contacts[0]?.contactId)
    expect(invoices[0]?.invoiceId).toBe(`${result.invoiceId}`)
    expect(`${result.invoiceNumber}`).toBe("INV-0001")
  })

  it("issues one authorised ACCREC invoice for a zero-tax Item", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedItem({
      itemCode: "TBS-100",
      name: "TBS Product",
      taxType: "NONE",
      taxPercent: 0,
    })

    await Effect.runPromise(issue(plugin.layer))
    const invoice = plugin.controller.listInvoices()[0]

    expect(invoice?.type).toBe("ACCREC")
    expect(invoice?.status).toBe("AUTHORISED")
    expect(invoice?.currency).toBe("NZD")
    expect(invoice?.reference).toBe("ORD-1001")
    expect(invoice?.date).toBe("2026-03-15")
    expect(invoice?.dueDate).toBe("2026-03-15")
    expect(invoice?.lineAmountTypes).toBe("Inclusive")
    expect(invoice?.lines).toEqual([
      {
        itemCode: "TBS-100",
        description: "TBS-100",
        quantity: "1",
        unitAmount: "100.00",
      },
    ])
    expect(invoice?.total).toBe("100.00")
    expect(invoice?.totalTax).toBe("0.00")
    expect(invoice?.subTotal).toBe("100.00")
  })

  it("keeps the same Agreed Price when the Item is 15 percent GST", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedItem({
      itemCode: "TBS-100",
      name: "TBS Product",
      taxType: "OUTPUT",
      taxPercent: 15,
    })

    await Effect.runPromise(issue(plugin.layer))
    const invoice = plugin.controller.listInvoices()[0]

    expect(invoice?.total).toBe("100.00")
    expect(invoice?.totalTax).toBe("13.04")
    expect(invoice?.subTotal).toBe("86.96")
    expect(invoice?.lines[0]?.unitAmount).toBe("100.00")
  })

  it("updates a unique email match with current name, email, and STREET address", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const existing = plugin.controller.seedContact({
      name: "Former Name",
      email: " ADA@EXAMPLE.COM ",
      addresses: [
        {
          addressType: "STREET",
          line1: "Old Street",
          city: "Auckland",
          postalCode: "1010",
        },
        {
          addressType: "POBOX",
          line1: "PO Box 88",
          city: "Auckland",
          postalCode: "1142",
        },
        {
          addressType: "DELIVERY",
          line1: "Warehouse 4",
          city: "Lower Hutt",
        },
      ],
    })

    await Effect.runPromise(issue(plugin.layer))
    const contacts = plugin.controller.listContacts()
    const invoices = plugin.controller.listInvoices()

    expect(contacts).toHaveLength(1)
    expect(contacts[0]?.contactId).toBe(existing.contactId)
    expect(contacts[0]?.name).toBe("Ada Lovelace")
    expect(contacts[0]?.email).toBe("ada@example.com")
    expect(contacts[0]?.addresses).toEqual([
      {
        addressType: "POBOX",
        line1: "PO Box 88",
        city: "Auckland",
        postalCode: "1142",
      },
      {
        addressType: "DELIVERY",
        line1: "Warehouse 4",
        city: "Lower Hutt",
      },
      {
        addressType: "STREET",
        line1: "10 Customhouse Quay",
        city: "Wellington",
        postalCode: "6011",
        country: "New Zealand",
      },
    ])
    expect(invoices[0]?.contactId).toBe(existing.contactId)
  })

  it("creates another contact when several matches share an email", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const first = plugin.controller.seedContact({
      name: "Ada One",
      email: "ada@example.com",
    })
    const second = plugin.controller.seedContact({
      name: "Ada Two",
      email: "Ada@example.com",
    })

    await Effect.runPromise(issue(plugin.layer))
    const contacts = plugin.controller.listContacts()
    const invoices = plugin.controller.listInvoices()

    // One normalized email may correspond to multiple Xero contacts.
    expect(contacts).toHaveLength(3)
    expect(invoices[0]?.contactId).not.toBe(first.contactId)
    expect(invoices[0]?.contactId).not.toBe(second.contactId)
    expect(invoices[0]?.contactId).toBe(contacts[2]?.contactId)
    expect(contacts[2]?.name).toBe("Ada Lovelace")
    expect(contacts[2]?.email).toBe("ada@example.com")
  })

  it("retries a unique-name conflict with a deterministic Order Number suffix", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "someone.else@example.com",
    })

    await Effect.runPromise(issue(plugin.layer))
    const created = plugin.controller.findContactByName("Ada Lovelace ORD-1001")
    const invoices = plugin.controller.listInvoices()

    expect(plugin.controller.findContactByName("Ada Lovelace")).toHaveLength(1)
    expect(created).toHaveLength(1)
    expect(created[0]?.email).toBe("ada@example.com")
    expect(created[0]?.addresses).toEqual([
      {
        addressType: "STREET",
        line1: "10 Customhouse Quay",
        city: "Wellington",
        postalCode: "6011",
        country: "New Zealand",
      },
    ])
    expect(invoices[0]?.contactId).toBe(created[0]?.contactId)
  })

  it("finds a prior suffixed contact deterministically for later reconciliation", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "someone.else@example.com",
    })
    const prior = plugin.controller.seedContact({
      name: "Ada Lovelace ORD-1001",
      email: "ada@example.com",
      addresses: [
        {
          addressType: "STREET",
          line1: "10 Customhouse Quay",
          city: "Wellington",
        },
      ],
    })

    await Effect.runPromise(issue(plugin.layer))
    const contacts = plugin.controller.listContacts()
    const invoices = plugin.controller.listInvoices()

    expect(contacts).toHaveLength(2)
    expect(invoices[0]?.contactId).toBe(prior.contactId)
    expect(
      plugin.controller.findContactByName("Ada Lovelace ORD-1001"),
    ).toHaveLength(1)
  })

  it("logs that one normalized email may match multiple Xero contacts", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.seedContact({
      name: "Ada One",
      email: "ada@example.com",
    })
    plugin.controller.seedContact({
      name: "Ada Two",
      email: "ada@example.com",
    })
    const logs: string[] = []
    const capturingLogger = Logger.make(({ message }) => {
      logs.push(String(message))
    })

    await Effect.runPromise(
      issue(plugin.layer).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger)),
      ),
    )

    expect(logs.join("\n")).toContain(
      "Creating another Xero contact because one normalized email matched multiple Xero contacts",
    )
  })

  it("fails for an unknown Product SKU after resolving the contact", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    const exit = await Effect.runPromiseExit(issue(plugin.layer))

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    const error = exit.cause
    const failure = String(error)
    expect(failure).toContain("Unknown Product SKU")
    expect(plugin.controller.listInvoices()).toHaveLength(0)
    expect(plugin.controller.listContacts()).toHaveLength(1)
  })

  it("uses deterministic invoice ids and numbering", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedItem({
      itemCode: "TBS-100",
      name: "TBS Product",
      taxType: "NONE",
      taxPercent: 0,
    })

    const first = await Effect.runPromise(issue(plugin.layer))
    const secondInput = await Effect.runPromise(
      decodeIssueAuthorisedSalesInvoiceInput({
        ...sampleInput,
        reference: "ORD-1002",
        customer: {
          name: "Grace Hopper",
          email: "grace@example.com",
        },
      }),
    )
    const second = await Effect.runPromise(
      issue(plugin.layer, secondInput, "todo-01JTESTXEROINVOICE00000002"),
    )

    expect(`${first.invoiceId}`).toBe("00000000-0000-4000-8000-e00000000001")
    expect(`${first.invoiceNumber}`).toBe("INV-0001")
    expect(`${second.invoiceId}`).toBe("00000000-0000-4000-8000-e00000000002")
    expect(`${second.invoiceNumber}`).toBe("INV-0002")
  })
})
