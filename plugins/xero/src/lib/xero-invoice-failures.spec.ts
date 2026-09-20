import { Effect, Either, Logger, Schema } from "effect"
import { CurrentStepJobContext } from "@pf/process"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { XeroInvoice } from "./xero-invoice"
import {
  type XeroTestFailureKind,
  makeXeroInvoiceTestPlugin,
} from "./xero-invoice-test"
import { describe, expect, it } from "bun:test"

const INVOICE_TODO = {
  todoId: "todo-01JTESTXEROFAILURE00000001",
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

const issue = (layer: ReturnType<typeof makeXeroInvoiceTestPlugin>["layer"]) =>
  Effect.gen(function* () {
    const xero = yield* XeroInvoice
    return yield* xero.issueAuthorisedSalesInvoice(sampleInput)
  }).pipe(
    Effect.either,
    Effect.provide(layer),
    Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
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

const expectFailure = async (
  plugin: ReturnType<typeof makeXeroInvoiceTestPlugin>,
  expected: {
    readonly retryable: boolean
    readonly code: string
    readonly fields?: readonly string[]
  },
) => {
  const result = await Effect.runPromise(issue(plugin.layer))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isRight(result)) {
    throw new Error("expected XeroInvoiceError")
  }
  expect(result.left._tag).toBe("XeroInvoiceError")
  expect(result.left.retryable).toBe(expected.retryable)
  expect(result.left.code).toBe(expected.code)
  if (expected.fields !== undefined) {
    expect(result.left.fields).toEqual(expected.fields)
  }
  expect(String(result.left)).not.toContain("Customhouse")
  expect(String(result.left)).not.toContain("Bearer ")
  expect(String(result.left)).not.toContain("xero-access-token")
  expect(String(result.left)).not.toContain("client_secret")
  return result.left
}

describe("Xero invoice failure classification", () => {
  const retryableKinds: ReadonlyArray<{
    readonly kind: XeroTestFailureKind
    readonly code: string
  }> = [
    { kind: "transport", code: "transport" },
    { kind: "timeout", code: "timeout" },
    { kind: "rate_limit", code: "rate_limit" },
    { kind: "provider_server", code: "provider_server" },
  ]

  const nonRetryableKinds: ReadonlyArray<{
    readonly kind: XeroTestFailureKind
    readonly code: string
  }> = [
    { kind: "validation", code: "validation" },
    { kind: "auth", code: "auth" },
    { kind: "permission", code: "permission" },
    { kind: "malformed_response", code: "malformed_response" },
    { kind: "unsupported_operation", code: "unsupported_operation" },
    { kind: "deployment", code: "deployment" },
  ]

  for (const { kind, code } of retryableKinds) {
    it(`tags ${kind} as retryable`, async () => {
      const plugin = makeXeroInvoiceTestPlugin()
      seedCatalogItem(plugin)
      plugin.controller.scriptFailure({ kind })
      await expectFailure(plugin, { retryable: true, code })
    })
  }

  for (const { kind, code } of nonRetryableKinds) {
    it(`tags ${kind} as non-retryable`, async () => {
      const plugin = makeXeroInvoiceTestPlugin()
      seedCatalogItem(plugin)
      if (kind === "validation") {
        plugin.controller.scriptFailure({
          kind: "validation",
          fields: ["UnitAmount"],
        })
      } else {
        plugin.controller.scriptFailure({ kind })
      }
      await expectFailure(plugin, {
        retryable: false,
        code,
        ...(kind === "validation" ? { fields: ["UnitAmount"] } : {}),
      })
    })
  }

  it("tags unknown ItemCode as non-retryable with ItemCode field detail", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    await expectFailure(plugin, {
      retryable: false,
      code: "unknown_item_code",
      fields: ["ItemCode"],
    })
    expect(plugin.controller.listInvoices()).toHaveLength(0)
    expect(plugin.controller.listContacts()).toHaveLength(1)
  })

  it("tags ambiguous Reference as non-retryable", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const contact = plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    plugin.controller.seedInvoice({
      contactId: contact.contactId,
      reference: "ORD-1001",
      date: "2026-03-15",
      dueDate: "2026-03-15",
      itemCode: "TBS-100",
      unitAmount: "100.00",
      total: "100.00",
      totalTax: "0.00",
      subTotal: "100.00",
    })
    plugin.controller.seedInvoice({
      contactId: contact.contactId,
      reference: "ORD-1001",
      date: "2026-03-15",
      dueDate: "2026-03-15",
      itemCode: "TBS-100",
      unitAmount: "100.00",
      total: "100.00",
      totalTax: "0.00",
      subTotal: "100.00",
      invoiceNumber: "INV-0099",
    })
    await expectFailure(plugin, {
      retryable: false,
      code: "ambiguous_reference",
    })
  })

  it("tags conflicting intent as non-retryable", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    const contact = plugin.controller.seedContact({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    plugin.controller.seedInvoice({
      contactId: contact.contactId,
      reference: "ORD-1001",
      date: "2026-03-15",
      dueDate: "2026-03-15",
      itemCode: "OTHER-SKU",
      unitAmount: "50.00",
      total: "50.00",
      totalTax: "0.00",
      subTotal: "50.00",
    })
    await expectFailure(plugin, {
      retryable: false,
      code: "intent_conflict",
    })
  })

  it("reconciles before another create after a provider-server failure", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptFailure({ kind: "provider_server", status: 503 })

    const first = await expectFailure(plugin, {
      retryable: true,
      code: "provider_server",
    })
    expect(first.message).toContain("503")
    expect(plugin.controller.listInvoices()).toHaveLength(0)

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        return yield* xero.issueAuthorisedSalesInvoice(sampleInput)
      }).pipe(
        Effect.provide(plugin.layer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
      ),
    )

    expect(`${second.invoiceNumber}`).toBe("INV-0001")
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

  it("returns the committed invoice after a provider-server failure that committed", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptFailure({
      kind: "provider_server",
      status: 500,
      afterCommit: true,
    })

    await expectFailure(plugin, {
      retryable: true,
      code: "provider_server",
    })
    expect(plugin.controller.listInvoices()).toHaveLength(1)
    const committed = plugin.controller.listInvoices()[0]

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        return yield* xero.issueAuthorisedSalesInvoice(sampleInput)
      }).pipe(
        Effect.provide(plugin.layer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
      ),
    )

    expect(`${second.invoiceId}`).toBe(`${committed?.invoiceId}`)
    expect(plugin.controller.listInvoices()).toHaveLength(1)
  })

  it("does not invent invoice identity from a malformed success", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptFailure({ kind: "malformed_response" })
    await expectFailure(plugin, {
      retryable: false,
      code: "malformed_response",
    })
    expect(plugin.controller.listInvoices()).toHaveLength(0)
  })

  it("scripts a rate-limit failure from an exhausted rate budget", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.seedRateBudget({ remaining: 0, retryAfterSeconds: 2 })
    const error = await expectFailure(plugin, {
      retryable: true,
      code: "rate_limit",
    })
    expect(error.retryAfterSeconds).toBe(2)
    expect(plugin.controller.listInvoices()).toHaveLength(0)
  })

  it("logs operational identity without shipping, payloads, or secrets", async () => {
    const plugin = makeXeroInvoiceTestPlugin()
    seedCatalogItem(plugin)
    plugin.controller.scriptFailure({ kind: "auth" })
    const logs: string[] = []
    const capturingLogger = Logger.make(({ message, annotations }) => {
      logs.push(
        `${String(message)} ${JSON.stringify(Object.fromEntries(annotations))}`,
      )
    })

    await Effect.runPromise(
      issue(plugin.layer).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger)),
      ),
    )

    const combined = logs.join("\n")
    expect(combined).toContain("ORD-1001")
    expect(combined).toContain("Ada Lovelace")
    expect(combined).toContain("ada@example.com")
    expect(combined).toContain("auth")
    expect(combined).not.toContain("Customhouse")
    expect(combined).not.toContain("xero-access-token")
    expect(combined).not.toContain("client_secret")
    expect(combined).not.toContain("Bearer ")
    expect(combined).not.toContain("Authorization")
  })
})
