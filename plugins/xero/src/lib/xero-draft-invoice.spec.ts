import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "@effect/platform"
import { Clock, ConfigProvider, Duration, Effect, Layer, Schema } from "effect"
import { xeroDraftIdempotencyKey } from "./idempotency"
import { DraftSalesInvoice, XeroDraftInvoice } from "./xero-draft-invoice"
import {
  XeroDraftInvoiceLive,
  XeroInvoiceConfigFromEnv,
} from "./xero-invoice-live"
import { describe, expect, it } from "bun:test"

const contactId = "00000000-0000-0000-0000-000000000001"
const invoiceId = "10000000-0000-0000-0000-000000000001"
const input = Schema.decodeUnknownSync(DraftSalesInvoice)({
  contactId,
  reference: "T4 2026",
  type: "ACCREC",
  status: "DRAFT",
  date: "2026-10-12",
  dueDate: "2026-10-12",
  currency: "NZD",
  lineAmountType: "Inclusive",
  totalCents: 99000,
  taxCents: 12913,
  subtotalCents: 86087,
  expectedRecipientEmails: ["parent@example.com"],
  lines: [
    {
      itemCode: "FEE",
      description: "Tuition",
      quantity: 1,
      unitAmountCents: 100000,
      lineAmountCents: 100000,
      taxCents: 13043,
      taxType: "OUTPUT2",
    },
    {
      itemCode: "LD",
      description: "Loyalty",
      quantity: 1,
      unitAmountCents: -1000,
      lineAmountCents: -1000,
      taxCents: -130,
      taxType: "OUTPUT2",
    },
  ],
})
const existing = (status = "DRAFT", reference = "T4 2026 Pupil Y11") => ({
  InvoiceID: invoiceId,
  InvoiceNumber: "INV-1",
  Contact: { ContactID: contactId },
  Type: "ACCREC",
  Status: status,
  Reference: reference,
})
const bodySchema = Schema.Struct({
  Invoices: Schema.Tuple(
    Schema.Struct({
      Type: Schema.Literal("ACCREC"),
      Status: Schema.Literal("DRAFT"),
      Contact: Schema.Struct({ ContactID: Schema.String }),
      Reference: Schema.String,
      Date: Schema.String,
      DueDate: Schema.String,
      CurrencyCode: Schema.String,
      LineAmountTypes: Schema.String,
      LineItems: Schema.Array(
        Schema.Struct({
          ItemCode: Schema.String,
          Description: Schema.String,
          Quantity: Schema.Number,
          UnitAmount: Schema.Number,
          LineAmount: Schema.Number,
          TaxAmount: Schema.Number,
          TaxType: Schema.String,
        }),
      ),
    }),
  ),
})
const realClock = Clock.make()
const fastClock = Object.assign(Clock.make(), {
  sleep: (duration: Duration.Duration) =>
    Duration.toMillis(duration) === 2000
      ? Effect.void
      : realClock.sleep(duration),
})

const harness = (
  options: {
    readonly status?: string
    readonly reference?: string
    readonly failRead?: boolean
    readonly loseWriteResponse?: boolean
    readonly corruptWriteResponse?: boolean
    readonly concurrent?: boolean
    readonly disabledRecipient?: boolean
    readonly extraRecipient?: boolean
    readonly missingRecipientIntent?: boolean
    readonly namedReference?: string
  } = {},
) => {
  const requests: { method: string; path: string; key: string | undefined }[] =
    []
  const invoices: ReturnType<typeof existing>[] = options.status
    ? [existing(options.status, options.reference)]
    : []
  let writes = 0
  let firstWrite = true
  let reads = 0
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const keys = new Set<string>()
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          key: request.headers["idempotency-key"],
        })
        const respond = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }))
        if (url.pathname === "/connect/token")
          return respond({
            access_token: "fixture",
            token_type: "Bearer",
            expires_in: 1800,
          })
        if (url.pathname === "/connections")
          return respond([{ tenantId: "fixture-tenant" }])
        if (url.pathname === "/api.xro/2.0/Contacts") {
          expect(request.method).toBe("GET")
          expect(url.searchParams.get("IDs")).toBe(contactId)
          return respond({
            Contacts: [
              {
                ContactID: contactId,
                Name: "Parent",
                ContactStatus: "ACTIVE",
                EmailAddress: options.disabledRecipient
                  ? ""
                  : "parent@example.com",
                ContactPersons: options.disabledRecipient
                  ? [
                      {
                        EmailAddress: "parent@example.com",
                        IncludeInEmails: false,
                      },
                    ]
                  : options.extraRecipient
                    ? [
                        {
                          EmailAddress: "extra@example.com",
                          IncludeInEmails: true,
                        },
                      ]
                    : [],
              },
            ],
          })
        }
        expect(url.pathname).toBe("/api.xro/2.0/Invoices")
        if (request.method === "GET") {
          expect(url.searchParams.get("ContactIDs")).toBe(contactId)
          expect(url.searchParams.get("Statuses")).toContain("VOIDED,DELETED")
          if (options.failRead) return respond({ Error: "Unavailable" }, 503)
          const snapshot = [...invoices]
          if (options.concurrent && reads++ < 2) {
            if (reads === 2) release?.()
            yield* Effect.promise(() => barrier)
          }
          return respond({ Invoices: snapshot })
        }
        expect(request.method).toBe("POST")
        if (request.body._tag !== "Uint8Array")
          throw new Error("Expected JSON body")
        const raw: unknown = JSON.parse(
          new TextDecoder().decode(request.body.body),
        )
        const dto = Schema.decodeUnknownSync(bodySchema)(raw).Invoices[0]
        expect(raw).not.toHaveProperty("Invoices.0.InvoiceID")
        expect(raw).not.toHaveProperty("Invoices.0.InvoiceNumber")
        const key = request.headers["idempotency-key"]
        expect(key).toBe(
          xeroDraftIdempotencyKey("fixture-tenant", contactId, input.reference),
        )
        if (!key) throw new Error("Missing idempotency key")
        if (!keys.has(key)) {
          writes++
          keys.add(key)
          invoices.push(existing("DRAFT", dto.Reference))
        }
        if (options.loseWriteResponse && firstWrite) {
          firstWrite = false
          return yield* new HttpClientError.RequestError({
            request,
            reason: "Transport",
            cause: new Error("Timed out after commit"),
          })
        }
        return respond({
          Invoices: [
            {
              ...existing("DRAFT", dto.Reference),
              ...dto,
              DateString: `${dto.Date}T00:00:00`,
              DueDateString: `${dto.DueDate}T00:00:00`,
              Total: options.corruptWriteResponse ? 999 : 990,
              TotalTax: 129.13,
              SubTotal: 860.87,
            },
          ],
        })
      }),
    ),
  )
  const layer = XeroDraftInvoiceLive.pipe(
    Layer.provide(XeroInvoiceConfigFromEnv),
    Layer.provide(http),
  )
  const config = ConfigProvider.fromMap(
    new Map([
      ["XERO_CLIENT_ID", "fixture"],
      ["XERO_CLIENT_SECRET", "fixture"],
    ]),
  )
  const { expectedRecipientEmails: _recipients, ...legacyInput } = input
  const operation = Effect.flatMap(XeroDraftInvoice, (service) =>
    service.createIfAbsent(
      options.namedReference
        ? {
            ...input,
            reference: options.namedReference,
            duplicateReference: input.reference,
          }
        : options.missingRecipientIntent
          ? legacyInput
          : input,
    ),
  )
  const run = () =>
    Effect.runPromise(
      operation.pipe(
        Effect.provide(layer),
        Effect.withConfigProvider(config),
        Effect.withClock(fastClock),
      ),
    )
  return {
    requests,
    run,
    writes: () => writes,
    expireKeys: () => keys.clear(),
    concurrent: () =>
      Effect.runPromise(
        Effect.all(
          [
            operation.pipe(Effect.provide(layer)),
            operation.pipe(Effect.provide(layer)),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.withConfigProvider(config), Effect.withClock(fastClock)),
      ),
  }
}

describe("Draft-only Xero creation", () => {
  it.each(["T4 2026", "T4 2026 Old name Y11"])(
    "rechecks the stable term scope before writing a named reference: %s",
    async (reference) => {
      const h = harness({
        status: "AUTHORISED",
        reference,
        namedReference: "T4 2026 New name Y11",
      })
      expect(await h.run()).toMatchObject({ kind: "skipped-existing" })
      expect(h.writes()).toBe(0)
    },
  )
  it("writes the named reference using the stable term idempotency key", async () => {
    const h = harness({ namedReference: "T4 2026 Lexine Y10" })
    expect(await h.run()).toMatchObject({ kind: "created-draft" })
    h.expireKeys()
    expect(await h.run()).toMatchObject({ kind: "skipped-existing" })
    expect(h.writes()).toBe(1)
  })
  it("rejects a duplicate scope unrelated to the display reference", () => {
    expect(() =>
      Schema.decodeUnknownSync(DraftSalesInvoice)({
        ...input,
        duplicateReference: "T3 2026",
      }),
    ).toThrow()
  })
  it.each([
    { disabledRecipient: true },
    { extraRecipient: true },
    { missingRecipientIntent: true },
  ])(
    "refuses a write without an exact live recipient match: %j",
    async (options) => {
      const h = harness(options)
      await expect(h.run()).rejects.toThrow(/recipient/i)
      expect(h.writes()).toBe(0)
    },
  )
  it("creates one draft with signed inclusive lines and skips it on a later run", async () => {
    const h = harness()
    expect(await h.run()).toMatchObject({
      kind: "created-draft",
      status: "DRAFT",
      invoiceId,
    })
    h.expireKeys()
    expect(await h.run()).toMatchObject({ kind: "skipped-existing" })
    expect(h.writes()).toBe(1)
    expect(
      h.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/Invoices"),
      ),
    ).toHaveLength(1)
  })
  it.each(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"])(
    "skips an existing %s invoice without changing it",
    async (status) => {
      const h = harness({ status, reference: " t4   2026 Existing pupil " })
      expect(await h.run()).toMatchObject({
        kind: "skipped-existing",
        existingInvoices: [{ status }],
      })
      expect(h.writes()).toBe(0)
    },
  )
  it("does not mistake a T3 invoice for T4", async () => {
    const h = harness({ status: "PAID", reference: "T3 2026" })
    expect(await h.run()).toMatchObject({ kind: "created-draft" })
    expect(h.writes()).toBe(1)
  })
  it("does not create when the duplicate check fails", async () => {
    const h = harness({ failRead: true })
    await expect(h.run()).rejects.toThrow()
    expect(h.writes()).toBe(0)
  })
  it("recovers a lost write response through a fresh lookup without another write", async () => {
    const h = harness({ loseWriteResponse: true })
    await expect(h.run()).rejects.toThrow("timed out")
    h.expireKeys()
    expect(await h.run()).toMatchObject({ kind: "skipped-existing" })
    expect(h.writes()).toBe(1)
  })
  it("coalesces competing executions with the same stable provider key", async () => {
    const h = harness({ concurrent: true })
    expect(await h.concurrent()).toHaveLength(2)
    expect(h.writes()).toBe(1)
  })
  it("rejects a created response with incorrect amounts", async () => {
    await expect(harness({ corruptWriteResponse: true }).run()).rejects.toThrow(
      "does not match",
    )
  })
  it("rejects authorisation and inconsistent amounts at the input boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(DraftSalesInvoice)({
        ...input,
        status: "AUTHORISED",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(DraftSalesInvoice)({ ...input, totalCents: 1 }),
    ).toThrow()
  })
  it("keys drafts by tenant, contact and normalized reference", () => {
    const key = xeroDraftIdempotencyKey("tenant", contactId, "T4 2026")
    expect(xeroDraftIdempotencyKey("tenant", contactId, " t4  2026 ")).toBe(key)
    expect(xeroDraftIdempotencyKey("other", contactId, "T4 2026")).not.toBe(key)
    expect(xeroDraftIdempotencyKey("tenant", invoiceId, "T4 2026")).not.toBe(
      key,
    )
    expect(xeroDraftIdempotencyKey("tenant", contactId, "T3 2026")).not.toBe(
      key,
    )
  })
})
