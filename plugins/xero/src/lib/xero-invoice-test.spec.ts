import { Effect, Logger, Result, Schema } from "effect"
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
  lines: [{ productSku: "TBS-100", quantity: 1, unitAmount: "100.00" }],
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
    description: "TBS Product",
    taxType: "NONE",
    taxPercent: 0,
  })
}

describe("XeroInvoice test Layer", () => {
  it("keeps website orders separate and recovers a lost create response beyond key expiry", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const first = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
      ...sampleInput,
      reference: "001281",
      legacyReference: "ord-first",
      internalNote: "Process Focus Customer Order ID: ord-first",
    })
    const second = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
      ...sampleInput,
      reference: "001282",
      legacyReference: "ord-second",
      internalNote: "Process Focus Customer Order ID: ord-second",
    })
    plugin.controller.scriptTimeoutAfterCommit("invoice.create")
    expect(
      Result.isFailure(
        await Effect.runPromise(issue(plugin.layer, first).pipe(Effect.result)),
      ),
    ).toBe(true)
    const other = await Effect.runPromise(
      issue(plugin.layer, second, "second-todo"),
    )
    plugin.controller.advanceTime(7 * 60 * 1000)
    const recovered = await Effect.runPromise(issue(plugin.layer, first))
    expect(recovered.invoiceId).not.toBe(other.invoiceId)
    expect(
      (await Effect.runPromise(issue(plugin.layer, second, "second-todo")))
        .invoiceId,
    ).toBe(other.invoiceId)
    expect(
      (await Effect.runPromise(issue(plugin.layer, first))).invoiceId,
    ).toBe(recovered.invoiceId)
    expect(
      plugin.controller.listInvoices().map((invoice) => ({
        reference: invoice.reference,
        notes: invoice.internalNotes,
      })),
    ).toEqual([
      { reference: "001281", notes: [first.internalNote!] },
      { reference: "001282", notes: [second.internalNote!] },
    ])
  })

  it("recovers an old unnumbered execution but refuses to create a ULID-reference replacement", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
      ...sampleInput,
      reference: "ord-legacy",
      legacyReference: "ord-legacy",
      recoveryOnly: true,
    })
    expect(
      Result.isFailure(
        await Effect.runPromise(issue(plugin.layer, input).pipe(Effect.result)),
      ),
    ).toBe(true)
    expect(plugin.controller.listInvoices()).toHaveLength(0)
    const contact = plugin.controller.listContacts()[0]!
    const existing = plugin.controller.seedInvoice({
      contactId: contact.contactId,
      reference: "ord-legacy",
      date: input.date,
      dueDate: input.dueDate,
      itemCode: "TBS-100",
      unitAmount: "100.00",
      total: "100.00",
      totalTax: "0.00",
      subTotal: "100.00",
    })
    expect(
      String((await Effect.runPromise(issue(plugin.layer, input))).invoiceId),
    ).toBe(existing.invoiceId)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

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
      {
        addressType: "POBOX",
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
      description: "TBS Product",
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
        description: "TBS Product",
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
      description: "TBS Product",
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

  it("issues ordered lines including repeated SKUs, with unit prices, inclusive totals and description snapshots", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    plugin.controller.seedItem({
      itemCode: "TBS-100",
      name: "Catalogue name is not the sales description",
      description: "Zero-tax product",
      taxType: "NONE",
      taxPercent: 0,
    })
    plugin.controller.seedItem({
      itemCode: "TBS-200",
      name: "GST product",
      description: "GST sales description",
      taxType: "OUTPUT",
      taxPercent: 15,
    })
    const input = await Effect.runPromise(
      decodeIssueAuthorisedSalesInvoiceInput({
        customer: sampleInput.customer,
        shippingAddress: sampleInput.shippingAddress,
        currency: "NZD",
        reference: sampleInput.reference,
        date: sampleInput.date,
        dueDate: sampleInput.dueDate,
        lines: [
          { productSku: "TBS-100", quantity: 3, unitAmount: "0.10" },
          { productSku: "TBS-200", quantity: 2, unitAmount: "11.50" },
          { productSku: "TBS-100", quantity: 1, unitAmount: "0.00" },
        ],
      }),
    )
    const result = await Effect.runPromise(issue(plugin.layer, input))
    expect(result.lines).toEqual([
      {
        itemCode: "TBS-100",
        quantity: 3,
        unitAmount: "0.10",
        description: "Zero-tax product",
      },
      {
        itemCode: "TBS-200",
        quantity: 2,
        unitAmount: "11.50",
        description: "GST sales description",
      },
      {
        itemCode: "TBS-100",
        quantity: 1,
        unitAmount: "0.00",
        description: "Zero-tax product",
      },
    ])
    expect(plugin.controller.listInvoices()[0]).toMatchObject({
      type: "ACCREC",
      status: "AUTHORISED",
      lineAmountTypes: "Inclusive",
      total: "23.30",
      totalTax: "3.00",
      subTotal: "20.30",
      lines: [
        { itemCode: "TBS-100", quantity: "3", unitAmount: "0.10" },
        { itemCode: "TBS-200", quantity: "2", unitAmount: "11.50" },
        { itemCode: "TBS-100", quantity: "1", unitAmount: "0.00" },
      ],
    })
  })

  it.each([undefined, "", " \t\n", "unknown"])(
    "rejects an unusable sales item on a later line (%j)",
    async (description) => {
      const plugin = makeXeroInvoiceTestPlugin()
      plugin.controller.seedItem({
        itemCode: "TBS-100",
        name: "Valid product",
        description: "Valid sales description",
        taxType: "NONE",
        taxPercent: 0,
      })
      if (description !== "unknown") {
        plugin.controller.seedItem({
          itemCode: "TBS-200",
          name: "A name must not replace a sales description",
          ...(description !== undefined && { description }),
          taxType: "NONE",
          taxPercent: 0,
        })
      }
      const input = await Effect.runPromise(
        decodeIssueAuthorisedSalesInvoiceInput({
          customer: sampleInput.customer,
          shippingAddress: sampleInput.shippingAddress,
          currency: "NZD",
          reference: sampleInput.reference,
          date: sampleInput.date,
          dueDate: sampleInput.dueDate,
          lines: [
            { productSku: "TBS-100", quantity: 1, unitAmount: "1.00" },
            { productSku: "TBS-200", quantity: 1, unitAmount: "1.00" },
          ],
        }),
      )
      const result = await Effect.runPromise(
        issue(plugin.layer, input).pipe(Effect.result),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe(
          description === "unknown" ? "unknown_item_code" : "validation",
        )
        expect(result.failure.retryable).toBe(false)
      }
      expect(plugin.controller.listInvoices()).toHaveLength(0)
    },
  )

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
      {
        addressType: "POBOX",
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
    expect(
      plugin.controller.findContactByName("Ada Lovelace ORD-1001")[0]
        ?.addresses,
    ).toContainEqual({
      addressType: "POBOX",
      line1: "10 Customhouse Quay",
      city: "Wellington",
      postalCode: "6011",
      country: "New Zealand",
    })
  })

  it.each([
    {},
    {
      attentionTo: " \t",
      line1: " ",
      line2: "\n",
      line3: "",
      line4: " ",
      city: " ",
      region: " ",
      postalCode: " ",
      country: " ",
    },
    ...[
      "attentionTo",
      "line1",
      "line2",
      "line3",
      "line4",
      "city",
      "region",
      "postalCode",
      "country",
    ].map((field) => ({ [field]: " Existing billing " })),
  ])(
    "defaults blank billing, preserves partial billing, and recovers a lost update: %j",
    async (content) => {
      const plugin = makeXeroInvoiceTestPlugin()
      seedCatalogItem(plugin)
      const billing = { addressType: "POBOX" as const, ...content }
      const existing = plugin.controller.seedContact({
        name: "Former Name",
        email: " ADA@EXAMPLE.COM ",
        addresses: [billing],
      })
      const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
        ...sampleInput,
        shippingAddress: {
          ...sampleInput.shippingAddress,
          line2: "Level 2",
          region: "Wellington",
        },
      })
      plugin.controller.scriptTimeoutAfterCommit("contact.update")
      expect(
        Result.isFailure(
          await Effect.runPromise(
            issue(plugin.layer, input).pipe(Effect.result),
          ),
        ),
      ).toBe(true)
      const issued = await Effect.runPromise(issue(plugin.layer, input))
      expect(await Effect.runPromise(issue(plugin.layer, input))).toEqual(
        issued,
      )
      plugin.controller.advanceTime(7 * 60 * 1000)
      expect(await Effect.runPromise(issue(plugin.layer, input))).toEqual(
        issued,
      )
      expect(plugin.controller.listContacts()).toHaveLength(1)
      const contact = plugin.controller.listContacts()[0]!
      expect(contact.contactId).toBe(existing.contactId)
      expect(
        contact.addresses.find((address) => address.addressType === "STREET"),
      ).toEqual({
        addressType: "STREET",
        line1: "10 Customhouse Quay",
        line2: "Level 2",
        city: "Wellington",
        region: "Wellington",
        postalCode: "6011",
        country: "New Zealand",
      })
      expect(
        contact.addresses.find((address) => address.addressType === "POBOX"),
      ).toEqual(
        Object.values(content).some((value) => value.trim())
          ? billing
          : { addressType: "POBOX", ...input.shippingAddress },
      )
      expect(plugin.controller.listInvoices()).toHaveLength(1)
    },
  )

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
      issue(plugin.layer).pipe(Effect.provide(Logger.layer([capturingLogger]))),
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
      description: "TBS Product",
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
