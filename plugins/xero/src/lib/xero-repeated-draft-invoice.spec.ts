import { Clock, ConfigProvider, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
  XeroDraftInvoiceLive,
  XeroInvoiceConfigFromEnv,
} from "./xero-invoice-live"
import {
  RepeatedDraftSalesInvoice,
  XeroRepeatedDraftInvoice,
} from "./xero-repeated-draft-invoice"
import { describe, expect, it } from "bun:test"

const input = Schema.decodeUnknownSync(RepeatedDraftSalesInvoice)({
  contactId: "00000000-0000-0000-0000-000000000001",
  expectedRecipientEmails: ["parent@example.com"],
  reference: "After School Care",
  type: "ACCREC",
  status: "DRAFT",
  date: "2026-09-26",
  dueDate: "2026-10-03",
  currency: "NZD",
  lineAmountType: "Inclusive",
  totalCents: 4500,
  taxCents: 587,
  subtotalCents: 3913,
  lines: [
    {
      itemCode: "ASC-430",
      description: "Care",
      quantity: 3,
      unitAmountCents: 1500,
      lineAmountCents: 4500,
      taxCents: 587,
      accountCode: "109/01",
      taxType: "OUTPUT2",
    },
    { description: "14 Sept to 25 Sept" },
  ],
})
const responseInvoice = {
  InvoiceID: "10000000-0000-0000-0000-000000000001",
  InvoiceNumber: "INV-1",
  Contact: { ContactID: input.contactId },
  Type: "ACCREC",
  Status: "DRAFT",
  Reference: "After School Care",
  DateString: "2026-09-26T00:00:00",
  DueDateString: "2026-10-03T00:00:00",
  CurrencyCode: "NZD",
  LineAmountTypes: "Inclusive",
  Total: 45,
  TotalTax: 5.87,
  SubTotal: 39.13,
  LineItems: [
    {
      ItemCode: "ASC-430",
      Description: "Care",
      Quantity: 3,
      UnitAmount: 15,
      LineAmount: 45,
      TaxAmount: 5.87,
      AccountCode: "109/01",
      TaxType: "OUTPUT2",
    },
    { Description: "14 Sept to 25 Sept" },
  ],
}
const harness = (
  options: {
    loseResponse?: boolean
    response?: object
    wrongRecipients?: boolean
    alwaysFail?: boolean
  } = {},
) => {
  const keys: string[] = []
  const payloads: unknown[] = []
  const committed = new Set<string>()
  let lost = false
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        const respond = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }))
        if (url.pathname.endsWith("/token"))
          return respond({
            access_token: "fixture",
            token_type: "Bearer",
            expires_in: 1800,
          })
        if (url.pathname === "/connections")
          return respond([{ tenantId: "fixture" }])
        if (url.pathname.endsWith("/Contacts"))
          return respond({
            Contacts: [
              {
                ContactID: input.contactId,
                Name: "Parent",
                ContactStatus: "ACTIVE",
                EmailAddress: options.wrongRecipients
                  ? "other@example.com"
                  : "parent@example.com",
              },
            ],
          })
        expect(url.pathname).toBe("/api.xro/2.0/Invoices")
        expect(request.method).toBe("POST") // No business duplicate lookup, including on retry.
        const key = request.headers["idempotency-key"]
        if (!key || request.body._tag !== "Uint8Array")
          throw new Error("Missing key/body")
        keys.push(key)
        payloads.push(JSON.parse(new TextDecoder().decode(request.body.body)))
        if (options.alwaysFail) return respond({}, 503)
        committed.add(key)
        if (options.loseResponse && !lost) {
          lost = true
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("Lost after commit"),
            }),
          })
        }
        return respond({
          Invoices: [{ ...responseInvoice, ...options.response }],
        })
      }),
    ),
  )
  const layer = XeroDraftInvoiceLive.pipe(
    Layer.provide(XeroInvoiceConfigFromEnv),
    Layer.provide(http),
  )
  const run = (invoice = input) =>
    Effect.runPromise(
      Effect.flatMap(XeroRepeatedDraftInvoice, (service) =>
        service.create(invoice),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            XERO_CLIENT_ID: "fixture",
            XERO_CLIENT_SECRET: "fixture",
          }),
        ),
        Effect.provideService(
          Clock.Clock,
          Object.assign(Clock.Clock.defaultValue(), {
            sleep: (duration: Duration.Duration) =>
              Duration.toMillis(duration) === 2000
                ? Effect.void
                : Clock.Clock.defaultValue().sleep(duration),
          }),
        ),
      ),
    )
  return { run, keys, payloads, committed }
}

describe("Repeated-reference drafts at the HTTP boundary", () => {
  it("retries a lost response with the same write key and creates again on a separately requested run", async () => {
    const h = harness({ loseResponse: true })
    expect(await h.run()).toMatchObject({
      kind: "created-draft",
      invoiceNumber: "INV-1",
    })
    expect(await h.run()).toMatchObject({ kind: "created-draft" })
    expect(h.keys).toHaveLength(3)
    expect(h.keys[0]).toBe(h.keys[1])
    expect(h.keys[2]).not.toBe(h.keys[0])
    expect(h.committed.size).toBe(2)
    expect(h.payloads[0]).toEqual({
      Invoices: [
        {
          Type: "ACCREC",
          Status: "DRAFT",
          Contact: { ContactID: input.contactId },
          Reference: "After School Care",
          Date: "2026-09-26",
          DueDate: "2026-10-03",
          CurrencyCode: "NZD",
          LineAmountTypes: "Inclusive",
          LineItems: responseInvoice.LineItems,
        },
      ],
    })
    expect(h.payloads[1]).toEqual(h.payloads[0])
  })
  it.each([
    { Total: 44 },
    { Reference: "Wrong" },
    { Status: "AUTHORISED" },
    { Contact: { ContactID: "00000000-0000-0000-0000-000000000002" } },
    {
      LineItems: [
        { ...responseInvoice.LineItems[0], UnitAmount: 14 },
        responseInvoice.LineItems[1],
      ],
    },
    {
      LineItems: [
        { ...responseInvoice.LineItems[0], AccountCode: "200" },
        responseInvoice.LineItems[1],
      ],
    },
    {
      LineItems: [
        responseInvoice.LineItems[0],
        { Description: "Wrong period" },
      ],
    },
    {
      LineItems: [
        responseInvoice.LineItems[0],
        { Description: "14 Sept to 25 Sept", LineAmount: 1 },
      ],
    },
    {
      LineItems: [
        responseInvoice.LineItems[0],
        {
          Description: "14 Sept to 25 Sept",
          Tracking: [{ Name: "Pupil", Option: "One" }],
        },
      ],
    },
  ])(
    "rejects mismatching returned draft identity, amount or lines: %j",
    async (response) => {
      const h = harness({ response })
      await expect(h.run()).rejects.toMatchObject({
        draftCreationOutcome: "unconfirmed",
      })
      expect(h.keys).toHaveLength(1)
    },
  )
  it("checks live recipients before writing", async () => {
    const h = harness({ wrongRecipients: true })
    await expect(h.run()).rejects.toMatchObject({
      draftCreationOutcome: "not-created",
      message: expect.stringContaining("recipients"),
    })
    expect(h.keys).toEqual([])
  })
  it("bounds provider retries and preserves their individual-write identity", async () => {
    const h = harness({ alwaysFail: true })
    await expect(h.run()).rejects.toMatchObject({
      draftCreationOutcome: "unconfirmed",
    })
    expect(h.keys).toHaveLength(3)
    expect(new Set(h.keys).size).toBe(1)
  })
  it("rejects invalid captured totals before any write", async () => {
    const h = harness()
    await expect(h.run({ ...input, totalCents: 1 })).rejects.toMatchObject({
      draftCreationOutcome: "not-created",
      message: expect.stringContaining("Invalid draft"),
    })
    expect(h.keys).toEqual([])
  })
})
