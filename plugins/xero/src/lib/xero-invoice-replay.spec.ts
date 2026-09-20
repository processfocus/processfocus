import { Effect, Either, Schema } from "effect"
import { CurrentStepJobContext } from "@pf/process"
import {
  XERO_IDEMPOTENCY_RETENTION_MS,
  xeroIdempotencyKey,
} from "./idempotency"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { XeroInvoice } from "./xero-invoice"
import { makeXeroInvoiceTestPlugin } from "./xero-invoice-test"
import { describe, expect, it } from "bun:test"

const INVOICE_TODO = {
  todoId: "todo-01JTESTXEROREPLAY000000001",
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
  todoId = INVOICE_TODO.todoId,
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

const compatibleInvoiceSeed = (contactId: string) => ({
  contactId,
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
  itemCode: "TBS-100",
  unitAmount: "100.00",
  total: "100.00",
  totalTax: "0.00",
  subTotal: "100.00",
})

describe("Xero Sales Invoice replay safety", () => {
  it("uses distinct Todo-derived keys for contact and invoice writes", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)

    await Effect.runPromise(issue(plugin.layer))
    const keys = plugin.controller.listIdempotencyKeys()

    expect(keys.map((record) => record.key).sort()).toEqual([
      xeroIdempotencyKey(INVOICE_TODO.todoId, "contact.create"),
      xeroIdempotencyKey(INVOICE_TODO.todoId, "invoice.create"),
    ])
    expect(keys[0]?.key).not.toBe(keys[1]?.key)
    expect(keys.every((record) => record.method === "POST")).toBe(true)
  })

  it("returns one contact and one Sales Invoice across identical retries inside the idempotency window", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)

    const first = await Effect.runPromise(issue(plugin.layer))
    const second = await Effect.runPromise(issue(plugin.layer))

    expect(`${second.invoiceId}`).toBe(`${first.invoiceId}`)
    expect(`${second.invoiceNumber}`).toBe(`${first.invoiceNumber}`)
    expect(plugin.controller.listContacts()).toHaveLength(1)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

  it("returns the same provider resources after the six-minute idempotency window expires", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)

    const first = await Effect.runPromise(issue(plugin.layer))
    plugin.controller.advanceTime(XERO_IDEMPOTENCY_RETENTION_MS + 1)
    const second = await Effect.runPromise(issue(plugin.layer))

    expect(`${second.invoiceId}`).toBe(`${first.invoiceId}`)
    expect(`${second.invoiceNumber}`).toBe(`${first.invoiceNumber}`)
    expect(plugin.controller.listContacts()).toHaveLength(1)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
    expect(
      plugin.controller
        .listIdempotencyKeys()
        .some(
          (record) =>
            record.key.endsWith(":contact.create") ||
            record.key.endsWith(":invoice.create"),
        ),
    ).toBe(false)
  })

  it("replays an identical in-window write after a timeout that committed", async () => {
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
    plugin.controller.scriptTimeoutAfterCommit("contact.create")

    const first = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )
    expect(Either.isLeft(first)).toBe(true)
    if (Either.isLeft(first)) {
      expect(first.left.retryable).toBe(true)
    }
    expect(plugin.controller.listContacts()).toHaveLength(3)
    expect(plugin.controller.listInvoices()).toHaveLength(0)

    const second = await Effect.runPromise(issue(plugin.layer))
    expect(plugin.controller.listContacts()).toHaveLength(3)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
    expect(`${second.invoiceNumber}`).toBe("INV-0001")
  })

  it("recovers a committed contact create after idempotency expiry", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptTimeoutAfterCommit("contact.create")

    const first = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )
    expect(Either.isLeft(first)).toBe(true)
    expect(plugin.controller.listContacts()).toHaveLength(1)
    expect(plugin.controller.listInvoices()).toHaveLength(0)

    plugin.controller.advanceTime(XERO_IDEMPOTENCY_RETENTION_MS + 1)
    const second = await Effect.runPromise(issue(plugin.layer))

    expect(plugin.controller.listContacts()).toHaveLength(1)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
    expect(plugin.controller.listInvoices()[0]?.contactId).toBe(
      plugin.controller.listContacts()[0]?.contactId,
    )
    expect(`${second.invoiceNumber}`).toBe("INV-0001")
  })

  it("recovers a committed invoice create by exact Order Number Reference", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptTimeoutAfterCommit("invoice.create")

    const first = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )
    expect(Either.isLeft(first)).toBe(true)
    if (Either.isLeft(first)) {
      expect(first.left.retryable).toBe(true)
    }
    expect(plugin.controller.listInvoices()).toHaveLength(1)
    const committed = plugin.controller.listInvoices()[0]

    const second = await Effect.runPromise(issue(plugin.layer))
    expect(`${second.invoiceId}`).toBe(`${committed?.invoiceId}`)
    expect(plugin.controller.listContacts()).toHaveLength(1)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

  it("fails when the same idempotency key is reused with a different body", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.seedIdempotencyWrite({
      key: xeroIdempotencyKey(INVOICE_TODO.todoId, "invoice.create"),
      method: "POST",
      target: "/Invoices",
      body: { Invoices: [{ Reference: "OTHER" }] },
    })

    const result = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) {
      throw new Error("expected idempotency conflict")
    }
    expect(result.left.retryable).toBe(false)
    expect(result.left.code).toBe("idempotency_conflict")
    expect(plugin.controller.listInvoices()).toHaveLength(0)
  })

  it("returns exactly one seeded compatible invoice as success", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const contact = plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    const seeded = plugin.controller.seedInvoice(
      compatibleInvoiceSeed(contact.contactId),
    )

    const result = await Effect.runPromise(issue(plugin.layer))

    expect(`${result.invoiceId}`).toBe(seeded.invoiceId)
    expect(`${result.invoiceNumber}`).toBe(seeded.invoiceNumber)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

  it("fails non-retryably when multiple invoices share a Reference", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const contact = plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    plugin.controller.seedInvoice(compatibleInvoiceSeed(contact.contactId))
    plugin.controller.seedInvoice({
      ...compatibleInvoiceSeed(contact.contactId),
      invoiceNumber: "INV-0099",
    })

    const result = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) {
      throw new Error("expected ambiguous Reference")
    }
    expect(result.left.retryable).toBe(false)
    expect(result.left.code).toBe("ambiguous_reference")
    expect(plugin.controller.listInvoices()).toHaveLength(2)
  })

  it("fails non-retryably and does not update a conflicting authorised invoice", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const contact = plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    const seeded = plugin.controller.seedInvoice({
      ...compatibleInvoiceSeed(contact.contactId),
      itemCode: "OTHER-SKU",
      unitAmount: "50.00",
      total: "50.00",
    })

    const result = await Effect.runPromise(
      issue(plugin.layer).pipe(Effect.either),
    )
    const after = plugin.controller.listInvoices()[0]

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) {
      throw new Error("expected intent conflict")
    }
    expect(result.left.retryable).toBe(false)
    expect(result.left.code).toBe("intent_conflict")
    expect(after).toEqual(seeded)
  })

  it("treats mismatches in contact, amount, dates, type, or status as conflicting intent", async () => {
    const cases = [
      {
        invoice: {
          contactId: "00000000-0000-4000-8000-c00000000099",
        },
      },
      { invoice: { unitAmount: "90.00", total: "90.00" } },
      { invoice: { date: "2026-03-14", dueDate: "2026-03-14" } },
      { invoice: { type: "ACCPAY" as const } },
      { invoice: { status: "DRAFT" as const } },
    ]

    for (const testCase of cases) {
      const plugin = makeXeroInvoiceTestPlugin()
      seedCatalogItem(plugin)
      const contact = plugin.controller.seedContact({
        name: "Ada Lovelace",
        email: "ada@example.com",
      })
      if (testCase.invoice.contactId !== undefined) {
        plugin.controller.seedContact({
          contactId: testCase.invoice.contactId,
          name: "Grace Hopper",
          email: "grace@example.com",
        })
      }
      plugin.controller.seedInvoice({
        ...compatibleInvoiceSeed(contact.contactId),
        ...testCase.invoice,
      })

      const result = await Effect.runPromise(
        issue(plugin.layer).pipe(Effect.either),
      )
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.code).toBe("intent_conflict")
        expect(result.left.retryable).toBe(false)
      }
      expect(plugin.controller.listInvoices()).toHaveLength(1)
    }
  })

  it("advances deterministic controller time through the retention window", () => {
    const plugin = makeXeroInvoiceTestPlugin()
    const started = plugin.controller.now()
    plugin.controller.advanceTime(XERO_IDEMPOTENCY_RETENTION_MS)
    expect(plugin.controller.now()).toBe(
      started + XERO_IDEMPOTENCY_RETENTION_MS,
    )
    plugin.controller.setNow(started)
    expect(plugin.controller.now()).toBe(started)
  })
})
