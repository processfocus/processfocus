import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Logger,
  Result,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { CurrentStepJobContext } from "@pf/process"
import { xeroIdempotencyKey } from "./idempotency"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { XeroInvoice } from "./xero-invoice"
import {
  XERO_TOKEN_REFRESH_BUFFER_MS,
  XeroInvoiceConfigFromEnv,
  XeroInvoiceLive,
} from "./xero-invoice-live"
import { XeroContactDetailsResponse } from "./xero-wire"
import { afterEach, describe, expect, it } from "bun:test"

const INVOICE_TODO = {
  todoId: "todo-01JTESTXEROLIVE00000000001",
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

const multiLineInput = Schema.decodeUnknownSync(
  IssueAuthorisedSalesInvoiceInput,
)({
  customer: sampleInput.customer,
  shippingAddress: sampleInput.shippingAddress,
  currency: "NZD",
  reference: sampleInput.reference,
  date: sampleInput.date,
  dueDate: sampleInput.dueDate,
  lines: [
    { productSku: "TBS-100", quantity: 3, unitAmount: "0.10" },
    { productSku: "TBS-200", quantity: 2, unitAmount: "11.50" },
  ],
})

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly tenantId: string | null
  readonly idempotencyKey: string | null
  readonly body: string
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

const defaultToken = {
  access_token: "xero-access-token",
  token_type: "Bearer",
  expires_in: 1800,
  scope: "accounting.invoices accounting.contacts",
}

const defaultConnection = [
  {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantType: "ORGANISATION",
  },
]

const defaultInvoice = {
  Invoices: [
    {
      InvoiceID: "22222222-2222-4222-8222-222222222222",
      InvoiceNumber: "INV-0100",
      Status: "AUTHORISED",
      Type: "ACCREC",
      LineItems: [
        {
          ItemCode: "TBS-100",
          Quantity: 1,
          UnitAmount: 100,
          Description: "TBS Product — sales description",
        },
      ],
    },
  ],
}

const defaultCreatedContact = {
  Contacts: [
    {
      ContactID: "33333333-3333-4333-8333-333333333333",
      Name: "Ada Lovelace",
      EmailAddress: "ada@example.com",
    },
  ],
}

const multiLineInvoice = {
  ...defaultInvoice.Invoices[0],
  Reference: "ORD-1001",
  CurrencyCode: "NZD",
  Date: "2026-03-15",
  DueDate: "2026-03-15",
  Contact: { ContactID: "33333333-3333-4333-8333-333333333333" },
  Total: 23.3,
  LineItems: [
    {
      ItemCode: "TBS-100",
      Quantity: 3,
      UnitAmount: 0.1,
      Description: "Issued zero-tax product",
    },
    {
      ItemCode: "TBS-200",
      Quantity: "2.0000",
      UnitAmount: "11.50",
      Description: "Issued GST product",
    },
  ],
}

const isContactsGet = (request: CapturedRequest): boolean =>
  request.method === "GET" &&
  request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")

const isContactsPost = (request: CapturedRequest): boolean =>
  request.method === "POST" &&
  request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")

const isConflictNameSearch = (request: CapturedRequest): boolean =>
  isContactsGet(request) &&
  request.url.includes(encodeURIComponent('Name=="Ada Lovelace ORD-1001"'))

const isEmailSearch = (request: CapturedRequest): boolean =>
  isContactsGet(request) &&
  request.url.includes(encodeURIComponent('EmailAddress=="ada@example.com"'))

const parseContactPost = (request: CapturedRequest | undefined) =>
  JSON.parse(request?.body ?? "{}") as {
    Contacts: ReadonlyArray<{
      ContactID?: string
      Name: string
      EmailAddress: string
      Addresses: ReadonlyArray<{
        AddressType: string
        AddressLine1: string
      }>
    }>
  }

const installFetch = (
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): { requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init)
    const captured: CapturedRequest = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      tenantId: request.headers.get("xero-tenant-id"),
      idempotencyKey: request.headers.get("idempotency-key"),
      body: await request.clone().text(),
    }
    requests.push(captured)
    return handler(captured)
  }) as typeof fetch
  return { requests }
}

const liveLayer = Layer.provideMerge(
  Layer.provideMerge(XeroInvoiceLive, XeroInvoiceConfigFromEnv),
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.effect(
        FetchHttpClient.Fetch,
        Effect.sync(() => globalThis.fetch),
      ),
    ),
  ),
)

const configProvider = ConfigProvider.fromEnvRecord(
  Object.fromEntries(
    new Map([
      ["XERO_CLIENT_ID", "xero-client-id"],
      ["XERO_CLIENT_SECRET", "xero-client-secret"],
    ]),
  ),
)

const isInvoicesGet = (request: CapturedRequest): boolean =>
  request.method === "GET" &&
  request.url.startsWith("https://api.xero.com/api.xro/2.0/Invoices")

const isInvoicesPost = (request: CapturedRequest): boolean =>
  request.method === "POST" &&
  request.url.startsWith("https://api.xero.com/api.xro/2.0/Invoices")

const isReferenceSearch = (request: CapturedRequest): boolean =>
  isInvoicesGet(request) &&
  request.url.includes(encodeURIComponent('Reference=="ORD-1001"'))

const issueInvoiceEffect = (input: typeof sampleInput = sampleInput) =>
  Effect.gen(function* () {
    const xero = yield* XeroInvoice
    return yield* xero.issueAuthorisedSalesInvoice(input)
  }).pipe(Effect.provideService(CurrentStepJobContext, INVOICE_TODO))

const issueInvoice = (input: typeof sampleInput = sampleInput) =>
  issueInvoiceEffect(input).pipe(
    Effect.provide(liveLayer),
    Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
  )

const successfulProvider = (request: CapturedRequest): Response | undefined => {
  if (request.url === "https://identity.xero.com/connect/token") {
    return jsonResponse(200, defaultToken)
  }
  if (request.url === "https://api.xero.com/connections") {
    return jsonResponse(200, defaultConnection)
  }
  if (isContactsGet(request)) {
    return jsonResponse(200, { Contacts: [] })
  }
  if (isContactsPost(request)) {
    return jsonResponse(200, defaultCreatedContact)
  }
  if (isInvoicesGet(request)) {
    return jsonResponse(200, { Invoices: [] })
  }
  if (isInvoicesPost(request)) {
    return jsonResponse(200, defaultInvoice)
  }
  return undefined
}

const expectTaggedFailure = async (
  effect: ReturnType<typeof issueInvoice>,
  expected: {
    readonly retryable: boolean
    readonly code: string
    readonly fields?: readonly string[]
    readonly externalWriteRejected?: true
  },
) => {
  const result = await Effect.runPromise(effect.pipe(Effect.result))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) {
    throw new Error("expected XeroInvoiceError")
  }
  expect(result.failure.retryable).toBe(expected.retryable)
  expect(result.failure.code).toBe(expected.code)
  expect(result.failure.externalWriteRejected).toBe(
    expected.externalWriteRejected,
  )
  if (expected.fields !== undefined) {
    expect(result.failure.fields).toEqual(expected.fields)
  }
  expect(String(result.failure)).not.toContain("Customhouse")
  expect(String(result.failure)).not.toContain("xero-access-token")
  expect(String(result.failure)).not.toContain("xero-client-secret")
  expect(String(result.failure)).not.toContain("Bearer ")
  return result.failure
}

describe("XeroInvoiceLive", () => {
  const originalFetch = globalThis.fetch

  it.each(["invoice-response-lost", "note-rejected", "note-response-lost"])(
    "recovers the same invoice and writes one internal note after %s across fresh workers",
    async (failure) => {
      const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
        ...sampleInput,
        reference: "001281",
        legacyReference: "ord-legacy-1281",
        internalNote: "Process Focus Customer Order ID: ord-legacy-1281",
      })
      const invoice = {
        ...multiLineInvoice,
        Reference: input.reference,
        LineItems: defaultInvoice.Invoices[0]!.LineItems,
        Total: 100,
      }
      let created = false
      let failed = false
      const notes: string[] = []
      const { requests } = installFetch((request) => {
        if (request.url.endsWith("/History")) {
          if (request.method === "PUT") {
            expect(JSON.parse(request.body)).toEqual({
              HistoryRecords: [{ Details: input.internalNote }],
            })
            if (!failed && failure === "note-rejected") {
              failed = true
              return jsonResponse(400, {
                Message: "History temporarily rejected",
              })
            }
            notes.push(input.internalNote!)
            if (!failed && failure === "note-response-lost") {
              failed = true
              throw new TypeError("response lost")
            }
          }
          return jsonResponse(200, {
            HistoryRecords: notes.map((Details) => ({ Details })),
          })
        }
        if (isInvoicesGet(request)) {
          const reference = new URL(request.url).searchParams.get("where")
          return jsonResponse(200, {
            Invoices:
              created && reference === 'Reference=="001281"' ? [invoice] : [],
          })
        }
        if (isInvoicesPost(request)) {
          created = true
          expect(JSON.parse(request.body).Invoices[0].Reference).toBe("001281")
          expect(request.body).not.toContain("ord-legacy-1281")
          if (!failed && failure === "invoice-response-lost") {
            failed = true
            throw new TypeError("response lost")
          }
          return jsonResponse(200, { Invoices: [invoice] })
        }
        return (
          successfulProvider(request) ??
          new Response("unhandled", { status: 500 })
        )
      })
      const first = await Effect.runPromise(
        issueInvoice(input).pipe(Effect.result),
      )
      expect(Result.isFailure(first)).toBe(true)
      if (Result.isFailure(first))
        expect(first.failure.externalWriteRejected).toBeUndefined()
      const recovered = await Effect.runPromise(issueInvoice(input))
      expect(String(recovered.invoiceId)).toBe(invoice.InvoiceID!)
      await Effect.runPromise(issueInvoice(input))
      expect(requests.filter(isInvoicesPost)).toHaveLength(1)
      expect(notes).toEqual([input.internalNote!])
    },
  )

  it.each([false, true])(
    "recovers legacy references without rewriting authorised invoices (conflicting new reference: %s)",
    async (conflict) => {
      const input = Schema.decodeUnknownSync(IssueAuthorisedSalesInvoiceInput)({
        ...multiLineInput,
        reference: "001281",
        legacyReference: "ord-legacy-1281",
      })
      const { requests } = installFetch((request) => {
        if (isContactsGet(request)) {
          if (new URL(request.url).pathname.includes("/Contacts/")) {
            return jsonResponse(200, {
              Contacts: [
                { ...defaultCreatedContact.Contacts[0], Addresses: [] },
              ],
            })
          }
          const legacyName =
            new URL(request.url).searchParams.get("where") ===
            'Name=="Ada Lovelace ord-legacy-1281"'
          return jsonResponse(200, {
            Contacts: legacyName
              ? defaultCreatedContact.Contacts.map((contact) => ({
                  ...contact,
                  Name: "Ada Lovelace ord-legacy-1281",
                }))
              : [],
          })
        }
        if (isInvoicesGet(request)) {
          const legacy =
            new URL(request.url).searchParams.get("where") ===
            'Reference=="ord-legacy-1281"'
          return jsonResponse(200, {
            Invoices:
              legacy || conflict
                ? [
                    {
                      ...multiLineInvoice,
                      Reference: legacy
                        ? input.legacyReference
                        : input.reference,
                      InvoiceID: legacy
                        ? multiLineInvoice.InvoiceID
                        : "44444444-4444-4444-8444-444444444444",
                    },
                  ]
                : [],
          })
        }
        return (
          successfulProvider(request) ??
          new Response("unhandled", { status: 500 })
        )
      })
      const result = await Effect.runPromise(
        issueInvoice(input).pipe(Effect.result),
      )
      expect(Result.isFailure(result)).toBe(conflict)
      if (Result.isSuccess(result))
        expect(String(result.success.invoiceId)).toBe(
          multiLineInvoice.InvoiceID!,
        )
      expect(requests.filter(isInvoicesPost)).toHaveLength(0)
      expect(requests.filter(isContactsPost)).toHaveLength(1)
    },
  )

  it("uses the durable replacement identity only for the invoice write", async () => {
    const { requests } = installFetch(
      (request) =>
        successfulProvider(request) ??
        new Response("unhandled", { status: 500 }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        return yield* xero.issueAuthorisedSalesInvoice(sampleInput)
      }).pipe(
        Effect.provideService(CurrentStepJobContext, {
          ...INVOICE_TODO,
          externalWriteAttemptId: "confirmed-rejection-retry",
        }),
        Effect.provide(liveLayer),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      ),
    )
    expect(requests.find(isContactsPost)?.idempotencyKey).toBe(
      xeroIdempotencyKey(INVOICE_TODO.todoId, "contact.create"),
    )
    expect(requests.find(isInvoicesPost)?.idempotencyKey).toBe(
      "confirmed-rejection-retry:invoice.create",
    )
    expect(requests.findIndex(isReferenceSearch)).toBeGreaterThanOrEqual(0)
    expect(requests.findIndex(isReferenceSearch)).toBeLessThan(
      requests.findIndex(isInvoicesPost),
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it.each([undefined, "", " \t\n"])(
    "retains invoice identity when its description is unavailable (%s)",
    async (description) => {
      installFetch((request) => {
        if (isInvoicesPost(request)) {
          return jsonResponse(200, {
            Invoices: [
              {
                ...defaultInvoice.Invoices[0],
                LineItems: [
                  {
                    ...defaultInvoice.Invoices[0]?.LineItems[0],
                    Description: description,
                  },
                ],
              },
            ],
          })
        }
        return (
          successfulProvider(request) ??
          new Response("unhandled", { status: 500 })
        )
      })
      const result = await Effect.runPromise(issueInvoice())
      expect(String(result.invoiceNumber)).toBe("INV-0100")
      expect(result.productDescription).toBe(description ?? "")
    },
  )

  it("authenticates with a Custom Connection and creates a contact and invoice", async () => {
    const { requests } = installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (
        request.method === "GET" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (
        request.method === "POST" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, defaultInvoice)
      }
      return new Response("unhandled", { status: 500 })
    })

    const result = await Effect.runPromise(issueInvoice())

    expect(`${result.invoiceId}`).toBe("22222222-2222-4222-8222-222222222222")
    expect(`${result.invoiceNumber}`).toBe("INV-0100")

    const tokenRequest = requests[0]
    expect(tokenRequest?.url).toBe("https://identity.xero.com/connect/token")
    expect(tokenRequest?.method).toBe("POST")
    expect(tokenRequest?.authorization?.startsWith("Basic ")).toBe(true)
    expect(tokenRequest?.body).toContain("grant_type=client_credentials")
    expect(tokenRequest?.body).toContain(
      "scope=accounting.invoices+accounting.contacts",
    )

    const nameSearch = requests.find(isConflictNameSearch)
    expect(nameSearch).toBeDefined()

    const contactSearch = requests.find(isEmailSearch)
    expect(contactSearch?.url).toContain(
      encodeURIComponent('EmailAddress=="ada@example.com"'),
    )

    expect(requests.find(isReferenceSearch)).toBeDefined()

    const contactCreate = requests.find(isContactsPost)
    const contactBody = parseContactPost(contactCreate)
    expect(contactCreate?.idempotencyKey).toBe(
      xeroIdempotencyKey(INVOICE_TODO.todoId, "contact.create"),
    )
    expect(contactBody.Contacts[0]?.ContactID).toBeUndefined()
    expect(contactBody.Contacts[0]?.Name).toBe("Ada Lovelace")
    expect(contactBody.Contacts[0]?.EmailAddress).toBe("ada@example.com")
    expect(contactBody.Contacts[0]?.Addresses).toHaveLength(2)
    expect(contactBody.Contacts[0]?.Addresses[1]).toMatchObject({
      AddressType: "POBOX",
      AddressLine1: "10 Customhouse Quay",
      City: "Wellington",
      PostalCode: "6011",
      Country: "New Zealand",
    })
    expect(contactBody.Contacts[0]?.Addresses[0]?.AddressType).toBe("STREET")
    expect(contactBody.Contacts[0]?.Addresses[0]?.AddressLine1).toBe(
      "10 Customhouse Quay",
    )

    expect(result.productDescription).toBe("TBS Product — sales description")
    const invoiceRequest = requests.find(isInvoicesPost)
    expect(invoiceRequest?.idempotencyKey).toBe(
      xeroIdempotencyKey(INVOICE_TODO.todoId, "invoice.create"),
    )
    expect(invoiceRequest?.idempotencyKey).not.toBe(
      contactCreate?.idempotencyKey,
    )
    expect(invoiceRequest?.url).toContain("SummarizeErrors=true")
    expect(invoiceRequest?.tenantId).toBe(
      "11111111-1111-4111-8111-111111111111",
    )
    const invoiceBody = JSON.parse(invoiceRequest?.body ?? "{}") as {
      Invoices: ReadonlyArray<{
        Type: string
        Status: string
        CurrencyCode: string
        Reference: string
        Date: string
        DueDate: string
        LineAmountTypes: string
        Contact: { ContactID: string }
        LineItems: ReadonlyArray<{
          ItemCode: string
          Quantity: number
          UnitAmount: string
        }>
      }>
    }
    const invoice = invoiceBody.Invoices[0]
    expect(invoice?.Type).toBe("ACCREC")
    expect(invoice?.Status).toBe("AUTHORISED")
    expect(invoice?.CurrencyCode).toBe("NZD")
    expect(invoice?.Reference).toBe("ORD-1001")
    expect(invoice?.Date).toBe("2026-03-15")
    expect(invoice?.DueDate).toBe("2026-03-15")
    expect(invoice?.LineAmountTypes).toBe("Inclusive")
    expect(invoice?.Contact.ContactID).toBe(
      "33333333-3333-4333-8333-333333333333",
    )
    expect(invoice?.LineItems).toEqual([
      {
        ItemCode: "TBS-100",
        Quantity: 1,
        UnitAmount: "100.00",
      },
    ])
  })

  it("sends one inclusive item per ordered line at its unit price and snapshots the issued lines", async () => {
    const { requests } = installFetch((request) => {
      if (isInvoicesPost(request)) {
        return jsonResponse(200, { Invoices: [multiLineInvoice] })
      }
      return (
        successfulProvider(request) ??
        new Response("unhandled", { status: 500 })
      )
    })
    const result = await Effect.runPromise(issueInvoice(multiLineInput))
    const body: unknown = JSON.parse(
      requests.find(isInvoicesPost)?.body ?? "{}",
    )
    expect(body).toMatchObject({
      Invoices: [
        {
          Type: "ACCREC",
          Status: "AUTHORISED",
          LineAmountTypes: "Inclusive",
          CurrencyCode: "NZD",
          LineItems: [
            { ItemCode: "TBS-100", Quantity: 3, UnitAmount: "0.10" },
            { ItemCode: "TBS-200", Quantity: 2, UnitAmount: "11.50" },
          ],
        },
      ],
    })
    expect(result.lines).toEqual([
      {
        itemCode: "TBS-100",
        quantity: 3,
        unitAmount: "0.10",
        description: "Issued zero-tax product",
      },
      {
        itemCode: "TBS-200",
        quantity: 2,
        unitAmount: "11.50",
        description: "Issued GST product",
      },
    ])
  })

  it.each([
    { name: "matching", change: {}, matches: true },
    {
      name: "wrong second item",
      change: {
        LineItems: [
          multiLineInvoice.LineItems[0],
          { ...multiLineInvoice.LineItems[1], ItemCode: "OTHER" },
        ],
      },
      matches: false,
    },
    {
      name: "wrong second quantity",
      change: {
        LineItems: [
          multiLineInvoice.LineItems[0],
          { ...multiLineInvoice.LineItems[1], Quantity: 1 },
        ],
      },
      matches: false,
    },
    {
      name: "wrong second unit price",
      change: {
        LineItems: [
          multiLineInvoice.LineItems[0],
          { ...multiLineInvoice.LineItems[1], UnitAmount: 23 },
        ],
      },
      matches: false,
    },
    {
      name: "missing line",
      change: { LineItems: [multiLineInvoice.LineItems[0]] },
      matches: false,
    },
    { name: "wrong total", change: { Total: 23.31 }, matches: false },
  ])(
    "reconciles multi-line wire responses: $name",
    async ({ change, matches }) => {
      const { requests } = installFetch((request) => {
        if (isInvoicesGet(request)) {
          return jsonResponse(200, {
            Invoices: [{ ...multiLineInvoice, ...change }],
          })
        }
        return (
          successfulProvider(request) ??
          new Response("unhandled", { status: 500 })
        )
      })
      const result = await Effect.runPromise(
        issueInvoice(multiLineInput).pipe(Effect.result),
      )
      if (matches) {
        expect(Result.isSuccess(result)).toBe(true)
        if (Result.isSuccess(result)) {
          expect(result.success.lines[1]).toEqual({
            itemCode: "TBS-200",
            quantity: 2,
            unitAmount: "11.50",
            description: "Issued GST product",
          })
        }
      } else {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe("intent_conflict")
          expect(result.failure.retryable).toBe(false)
        }
      }
      expect(requests.some(isInvoicesPost)).toBe(false)
    },
  )

  it.each([
    { addresses: [], fallback: true },
    { addresses: [{ AddressType: "POBOX" }], fallback: true },
    {
      addresses: [
        {
          AddressType: "POBOX",
          AttentionTo: " \t",
          AddressLine1: " ",
          AddressLine2: "\n",
          City: " ",
          Region: null,
          PostalCode: "",
          Country: " ",
        },
      ],
      fallback: true,
    },
    ...[
      "AttentionTo",
      "AddressLine1",
      "AddressLine2",
      "AddressLine3",
      "AddressLine4",
      "City",
      "Region",
      "PostalCode",
      "Country",
    ].map((field) => ({
      addresses: [{ AddressType: "POBOX", [field]: "  Existing billing  " }],
      fallback: false,
    })),
  ])(
    "uses full contact addresses to default only empty billing: %j",
    async ({ addresses, fallback }) => {
      const { requests } = installFetch((request) => {
        if (request.url === "https://identity.xero.com/connect/token") {
          return jsonResponse(200, defaultToken)
        }
        if (request.url === "https://api.xero.com/connections") {
          return jsonResponse(200, defaultConnection)
        }
        if (isConflictNameSearch(request)) {
          return jsonResponse(200, { Contacts: [] })
        }
        if (isEmailSearch(request)) {
          return jsonResponse(200, {
            Contacts: [
              {
                ContactID: "33333333-3333-4333-8333-333333333333",
                Name: "Former Name",
                EmailAddress: "ADA@example.com",
              },
            ],
          })
        }
        if (
          isContactsGet(request) &&
          new URL(request.url).pathname.endsWith(
            "/Contacts/33333333-3333-4333-8333-333333333333",
          )
        ) {
          return jsonResponse(200, {
            Contacts: [
              { ...defaultCreatedContact.Contacts[0], Addresses: addresses },
            ],
          })
        }
        if (isContactsPost(request)) {
          return jsonResponse(200, defaultCreatedContact)
        }
        if (isInvoicesGet(request)) {
          return jsonResponse(200, { Invoices: [] })
        }
        if (isInvoicesPost(request)) {
          return jsonResponse(200, defaultInvoice)
        }
        return new Response("unhandled", { status: 500 })
      })

      await Effect.runPromise(issueInvoice())

      const contactUpdate = requests.find(isContactsPost)
      const contactBody = parseContactPost(contactUpdate)
      expect(contactBody.Contacts[0]?.ContactID).toBe(
        "33333333-3333-4333-8333-333333333333",
      )
      expect(contactBody.Contacts[0]?.Name).toBe("Ada Lovelace")
      expect(contactBody.Contacts[0]?.EmailAddress).toBe("ada@example.com")
      expect(contactBody.Contacts[0]?.Addresses).toHaveLength(fallback ? 2 : 1)
      if (fallback)
        expect(contactBody.Contacts[0]?.Addresses[1]?.AddressType).toBe("POBOX")
      expect(contactBody.Contacts[0]?.Addresses[0]?.AddressType).toBe("STREET")
      expect(contactBody.Contacts[0]?.Addresses[0]?.AddressLine1).toBe(
        "10 Customhouse Quay",
      )
      const invoiceRequest = requests.find(isInvoicesPost)
      const invoiceBody = JSON.parse(invoiceRequest?.body ?? "{}") as {
        Invoices: ReadonlyArray<{ Contact: { ContactID: string } }>
      }
      expect(invoiceBody.Invoices[0]?.Contact.ContactID).toBe(
        "33333333-3333-4333-8333-333333333333",
      )
    },
  )

  it.each([
    {
      status: 200,
      contacts: [{ ...defaultCreatedContact.Contacts[0] }],
      headers: {},
    },
    {
      status: 200,
      contacts: [
        {
          ...defaultCreatedContact.Contacts[0],
          Addresses: [{ AddressType: "POBOX", City: 42 }],
        },
      ],
      headers: {},
    },
    { status: 200, contacts: [], headers: {} },
    {
      status: 200,
      contacts: [
        { ContactID: "44444444-4444-4444-8444-444444444444", Addresses: [] },
      ],
      headers: {},
    },
    {
      status: 206,
      contacts: [{ ...defaultCreatedContact.Contacts[0], Addresses: [] }],
      headers: {},
    },
    {
      status: 200,
      contacts: [{ ...defaultCreatedContact.Contacts[0], Addresses: [] }],
      headers: { "Content-Range": "0-0/2" },
    },
  ])(
    "refuses to infer empty billing from incomplete or malformed detail: %j",
    async ({ status, contacts, headers }) => {
      const { requests } = installFetch((request) => {
        if (isEmailSearch(request))
          return jsonResponse(200, defaultCreatedContact)
        if (
          isContactsGet(request) &&
          new URL(request.url).pathname.includes("/Contacts/")
        )
          return jsonResponse(status, { Contacts: contacts }, headers)
        return (
          successfulProvider(request) ??
          new Response("unhandled", { status: 500 })
        )
      })
      await expectTaggedFailure(issueInvoice(), {
        code: "malformed_response",
        retryable: false,
      })
      expect(requests.some(isContactsPost)).toBe(false)
      expect(requests.some(isInvoicesPost)).toBe(false)
    },
  )

  it("creates another contact when several email matches exist", async () => {
    const { requests } = installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isConflictNameSearch(request)) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isEmailSearch(request)) {
        return jsonResponse(200, {
          Contacts: [
            {
              ContactID: "44444444-4444-4444-8444-444444444444",
              Name: "Ada One",
              EmailAddress: "ada@example.com",
            },
            {
              ContactID: "55555555-5555-4555-8555-555555555555",
              Name: "Ada Two",
              EmailAddress: "ada@example.com",
            },
          ],
        })
      }
      if (isContactsPost(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, defaultInvoice)
      }
      return new Response("unhandled", { status: 500 })
    })

    await Effect.runPromise(issueInvoice())

    const contactCreate = requests.find(isContactsPost)
    expect(
      parseContactPost(contactCreate).Contacts[0]?.ContactID,
    ).toBeUndefined()
    const invoiceRequest = requests.find(isInvoicesPost)
    const invoiceBody = JSON.parse(invoiceRequest?.body ?? "{}") as {
      Invoices: ReadonlyArray<{ Contact: { ContactID: string } }>
    }
    expect(invoiceBody.Invoices[0]?.Contact.ContactID).toBe(
      "33333333-3333-4333-8333-333333333333",
    )
  })

  it("reconciles a lost billing fallback response across fresh workers without reusing a key for a different payload", async () => {
    let addresses: (typeof XeroContactDetailsResponse.Type)["Contacts"][number]["Addresses"] =
      []
    const writes = new Map<string, string>()
    let lost = false
    let invoiced = false
    const { requests } = installFetch((request) => {
      if (isEmailSearch(request))
        return jsonResponse(200, defaultCreatedContact)
      if (
        isContactsGet(request) &&
        new URL(request.url).pathname.includes("/Contacts/")
      )
        return jsonResponse(200, {
          Contacts: [
            { ...defaultCreatedContact.Contacts[0], Addresses: addresses },
          ],
        })
      if (isContactsPost(request)) {
        const prior = writes.get(request.idempotencyKey!)
        if (prior !== undefined && prior !== request.body)
          return jsonResponse(400, {
            Message: "Idempotency key used for a different request",
          })
        writes.set(request.idempotencyKey!, request.body)
        const posted = Schema.decodeUnknownSync(
          Schema.fromJsonString(XeroContactDetailsResponse),
        )(request.body).Contacts[0]!
        for (const address of posted.Addresses)
          addresses = [
            ...addresses.filter(
              (old) => old.AddressType !== address.AddressType,
            ),
            address,
          ]
        if (!lost) {
          lost = true
          throw new TypeError("response lost after contact commit")
        }
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesPost(request)) {
        invoiced = true
        return jsonResponse(200, {
          Invoices: [
            {
              ...multiLineInvoice,
              Total: 100,
              LineItems: defaultInvoice.Invoices[0]!.LineItems,
            },
          ],
        })
      }
      if (isInvoicesGet(request))
        return jsonResponse(200, {
          Invoices: invoiced
            ? [
                {
                  ...multiLineInvoice,
                  Total: 100,
                  LineItems: defaultInvoice.Invoices[0]!.LineItems,
                },
              ]
            : [],
        })
      return (
        successfulProvider(request) ??
        new Response("unhandled", { status: 500 })
      )
    })
    await expectTaggedFailure(issueInvoice(), {
      code: "transport",
      retryable: true,
    })
    const issued = await Effect.runPromise(issueInvoice())
    expect(await Effect.runPromise(issueInvoice())).toEqual(issued)
    expect(requests.filter(isInvoicesPost)).toHaveLength(1)
    expect(
      addresses.find((address) => address.AddressType === "POBOX"),
    ).toMatchObject({ AddressLine1: "10 Customhouse Quay" })
    expect(writes.size).toBe(2)
  })

  it("retries a unique-name conflict with the Order Number suffix", async () => {
    let contactPostCount = 0
    const { requests } = installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isContactsGet(request)) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isContactsPost(request)) {
        contactPostCount += 1
        if (contactPostCount === 1) {
          return jsonResponse(400, {
            Type: "ValidationException",
            Message: "A validation exception occurred",
            Elements: [
              {
                ValidationErrors: [
                  { Message: "The contact name must be unique." },
                ],
              },
            ],
          })
        }
        return jsonResponse(200, {
          Contacts: [
            {
              ContactID: "66666666-6666-4666-8666-666666666666",
              Name: "Ada Lovelace ORD-1001",
              EmailAddress: "ada@example.com",
            },
          ],
        })
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, defaultInvoice)
      }
      return new Response("unhandled", { status: 500 })
    })

    await Effect.runPromise(issueInvoice())

    const posted = requests.filter(isContactsPost)
    expect(posted).toHaveLength(2)
    expect(posted[0]?.idempotencyKey).toBe(
      xeroIdempotencyKey(INVOICE_TODO.todoId, "contact.create"),
    )
    expect(posted[1]?.idempotencyKey).toBe(
      xeroIdempotencyKey(INVOICE_TODO.todoId, "contact.create.conflict"),
    )
    expect(parseContactPost(posted[0]).Contacts[0]?.Name).toBe("Ada Lovelace")
    expect(parseContactPost(posted[1]).Contacts[0]?.Name).toBe(
      "Ada Lovelace ORD-1001",
    )
    const invoiceRequest = requests.find(isInvoicesPost)
    const invoiceBody = JSON.parse(invoiceRequest?.body ?? "{}") as {
      Invoices: ReadonlyArray<{ Contact: { ContactID: string } }>
    }
    expect(invoiceBody.Invoices[0]?.Contact.ContactID).toBe(
      "66666666-6666-4666-8666-666666666666",
    )
  })

  it("reuses a prior suffixed contact instead of creating another", async () => {
    const { requests } = installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isConflictNameSearch(request)) {
        return jsonResponse(200, {
          Contacts: [
            {
              ContactID: "77777777-7777-4777-8777-777777777777",
              Name: "Ada Lovelace ORD-1001",
              EmailAddress: "ada@example.com",
            },
          ],
        })
      }
      if (isContactsGet(request) || isContactsPost(request)) {
        return jsonResponse(200, {
          Contacts: [
            {
              ContactID: "77777777-7777-4777-8777-777777777777",
              Name: "Ada Lovelace ORD-1001",
              EmailAddress: "ada@example.com",
              Addresses: [],
            },
          ],
        })
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, defaultInvoice)
      }
      return new Response("unhandled", { status: 500 })
    })

    await Effect.runPromise(issueInvoice())

    expect(requests.some(isEmailSearch)).toBe(false)
    expect(
      parseContactPost(requests.find(isContactsPost)).Contacts[0],
    ).toMatchObject({
      ContactID: "77777777-7777-4777-8777-777777777777",
      Name: "Ada Lovelace ORD-1001",
      Addresses: [{ AddressType: "STREET" }, { AddressType: "POBOX" }],
    })
    const invoiceRequest = requests.find(isInvoicesPost)
    const invoiceBody = JSON.parse(invoiceRequest?.body ?? "{}") as {
      Invoices: ReadonlyArray<{ Contact: { ContactID: string } }>
    }
    expect(invoiceBody.Invoices[0]?.Contact.ContactID).toBe(
      "77777777-7777-4777-8777-777777777777",
    )
  })

  it("rejects an untyped contact identity that is not a GUID", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isConflictNameSearch(request)) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isEmailSearch(request)) {
        return jsonResponse(200, {
          Contacts: [
            {
              ContactID: "not-a-guid",
              Name: "Ada Lovelace",
              EmailAddress: "ada@example.com",
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(issueInvoice())
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    expect(String(exit.cause)).toContain("Malformed Xero contact response")
  })

  it("does not invent invoice identity from a malformed success payload", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (
        request.method === "GET" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (
        request.method === "POST" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, { Invoices: [{ Status: "AUTHORISED" }] })
      }
      return new Response("unhandled", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(issueInvoice())
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    expect(String(exit.cause)).toContain("Malformed Xero invoice response")
    expect(String(exit.cause)).not.toContain("xero-access-token")
  })

  it("maps an unknown ItemCode validation error", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (
        request.method === "GET" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (
        request.method === "POST" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(400, {
          Type: "ValidationException",
          Elements: [
            {
              ValidationErrors: [
                { Message: "Item code 'TBS-100' is not valid" },
              ],
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(issueInvoice())
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    expect(String(exit.cause)).toContain("Unknown Product SKU")
  })

  it("tags unknown ItemCode as non-retryable with ItemCode field detail", async () => {
    installFetch((request) => {
      const handled = successfulProvider(request)
      if (handled !== undefined && !isInvoicesPost(request)) {
        return handled
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(400, {
          Type: "ValidationException",
          Elements: [
            {
              ValidationErrors: [
                { Message: "Item code 'TBS-100' is not valid" },
              ],
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "unknown_item_code",
      fields: ["ItemCode"],
      externalWriteRejected: true,
    })
  })

  it("logs operational identity without shipping or secrets", async () => {
    const logs: string[] = []
    const capturingLogger = Logger.make((options) => {
      const { message, annotations } = Logger.formatStructured.log(options)
      logs.push(`${String(message)} ${JSON.stringify(annotations)}`)
    })

    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (
        request.method === "GET" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (
        request.method === "POST" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, defaultInvoice)
      }
      return new Response("unhandled", { status: 500 })
    })

    await Effect.runPromise(
      issueInvoice().pipe(Effect.provide(Logger.layer([capturingLogger]))),
    )

    const combined = logs.join("\n")
    expect(combined).toContain("ORD-1001")
    expect(combined).toContain("INV-0100")
    expect(combined).toContain("Ada Lovelace")
    expect(combined).toContain("ada@example.com")
    expect(combined).not.toContain("Customhouse")
    expect(combined).not.toContain("xero-access-token")
    expect(combined).not.toContain("xero-client-secret")
    expect(combined).not.toContain("Bearer ")
  })

  it("returns one compatible invoice found by exact Reference without creating another", async () => {
    const { requests } = installFetch((request) => {
      if (
        isContactsGet(request) &&
        new URL(request.url).pathname.includes("/Contacts/")
      )
        return jsonResponse(200, {
          Contacts: [{ ...defaultCreatedContact.Contacts[0], Addresses: [] }],
        })
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isConflictNameSearch(request)) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isEmailSearch(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isContactsPost(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isReferenceSearch(request)) {
        return jsonResponse(200, {
          Invoices: [
            {
              InvoiceID: "22222222-2222-4222-8222-222222222222",
              InvoiceNumber: "INV-0100",
              Status: "AUTHORISED",
              Type: "ACCREC",
              Reference: "ORD-1001",
              CurrencyCode: "NZD",
              Date: "2026-03-15",
              DueDate: "2026-03-15",
              Contact: {
                ContactID: "33333333-3333-4333-8333-333333333333",
              },
              LineItems: [
                {
                  ItemCode: "TBS-100",
                  Description: "Original invoiced product",
                  Quantity: 1,
                  UnitAmount: 100,
                },
              ],
              Total: 100,
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const result = await Effect.runPromise(issueInvoice())

    expect(`${result.invoiceId}`).toBe("22222222-2222-4222-8222-222222222222")
    expect(`${result.invoiceNumber}`).toBe("INV-0100")
    expect(result.productDescription).toBe("Original invoiced product")
    expect(requests.some(isInvoicesPost)).toBe(false)
  })

  it("fails when an existing Reference invoice has conflicting intent", async () => {
    installFetch((request) => {
      if (
        isContactsGet(request) &&
        new URL(request.url).pathname.includes("/Contacts/")
      )
        return jsonResponse(200, {
          Contacts: [{ ...defaultCreatedContact.Contacts[0], Addresses: [] }],
        })
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isConflictNameSearch(request)) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isEmailSearch(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isContactsPost(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isReferenceSearch(request)) {
        return jsonResponse(200, {
          Invoices: [
            {
              InvoiceID: "22222222-2222-4222-8222-222222222222",
              InvoiceNumber: "INV-0100",
              Status: "AUTHORISED",
              Type: "ACCREC",
              Reference: "ORD-1001",
              CurrencyCode: "NZD",
              Date: "2026-03-15",
              DueDate: "2026-03-15",
              Contact: {
                ContactID: "33333333-3333-4333-8333-333333333333",
              },
              LineItems: [
                {
                  ItemCode: "OTHER-SKU",
                  Quantity: 1,
                  UnitAmount: 50,
                },
              ],
              Total: 50,
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(issueInvoice())
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    expect(String(exit.cause)).toContain(
      "does not match this Sales Invoice intent",
    )
  })

  it("maps a changed-body idempotency key conflict", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (
        request.method === "GET" &&
        request.url.startsWith("https://api.xero.com/api.xro/2.0/Contacts")
      ) {
        return jsonResponse(200, { Contacts: [] })
      }
      if (isContactsPost(request)) {
        return jsonResponse(200, defaultCreatedContact)
      }
      if (isInvoicesGet(request)) {
        return jsonResponse(200, { Invoices: [] })
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(400, {
          Type: "ValidationException",
          Message:
            "Idempotency Key: todo-01JTESTXEROLIVE00000000001:invoice.create is used with a different request.",
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(issueInvoice())
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("expected failure")
    }
    expect(String(exit.cause)).toContain("idempotency key was reused")
  })

  it("reuses a cached access token across Sales Invoice attempts", async () => {
    const { requests } = installFetch((request) => {
      const handled = successfulProvider(request)
      return handled ?? new Response("unhandled", { status: 500 })
    })
    const secondInput = Schema.decodeUnknownSync(
      IssueAuthorisedSalesInvoiceInput,
    )({
      ...sampleInput,
      reference: "ORD-1002",
      customer: { name: "Grace Hopper", email: "grace@example.com" },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        yield* xero.issueAuthorisedSalesInvoice(sampleInput)
        yield* xero.issueAuthorisedSalesInvoice(secondInput)
      }).pipe(
        Effect.provide(liveLayer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      ),
    )

    expect(
      requests.filter(
        (request) => request.url === "https://identity.xero.com/connect/token",
      ),
    ).toHaveLength(1)
  })

  it("refreshes the access token shortly before expiry", async () => {
    const { requests } = installFetch((request) => {
      const handled = successfulProvider(request)
      return handled ?? new Response("unhandled", { status: 500 })
    })
    const secondInput = Schema.decodeUnknownSync(
      IssueAuthorisedSalesInvoiceInput,
    )({
      ...sampleInput,
      reference: "ORD-1002",
      customer: { name: "Grace Hopper", email: "grace@example.com" },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        yield* xero.issueAuthorisedSalesInvoice(sampleInput)
        yield* TestClock.adjust(
          defaultToken.expires_in * 1000 - XERO_TOKEN_REFRESH_BUFFER_MS + 1,
        )
        yield* xero.issueAuthorisedSalesInvoice(secondInput)
      }).pipe(
        Effect.provide(liveLayer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(
      requests.filter(
        (request) => request.url === "https://identity.xero.com/connect/token",
      ),
    ).toHaveLength(2)
  })

  it("coalesces concurrent token refreshes", async () => {
    let tokenRequests = 0
    installFetch(async (request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        tokenRequests += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
        return jsonResponse(200, defaultToken)
      }
      const handled = successfulProvider(request)
      return handled ?? new Response("unhandled", { status: 500 })
    })
    const secondInput = Schema.decodeUnknownSync(
      IssueAuthorisedSalesInvoiceInput,
    )({
      ...sampleInput,
      reference: "ORD-1002",
      customer: { name: "Grace Hopper", email: "grace@example.com" },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        yield* Effect.all(
          [
            xero.issueAuthorisedSalesInvoice(sampleInput),
            xero.issueAuthorisedSalesInvoice(secondInput),
          ],
          { concurrency: 2 },
        )
      }).pipe(
        Effect.provide(liveLayer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      ),
    )

    expect(tokenRequests).toBe(1)
  })

  it("fails immediately for missing Custom Connection configuration", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const xero = yield* XeroInvoice
        return yield* xero.issueAuthorisedSalesInvoice(sampleInput)
      }).pipe(
        Effect.provide(liveLayer),
        Effect.provideService(CurrentStepJobContext, INVOICE_TODO),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(Object.fromEntries(new Map())),
        ),
        Effect.result,
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) {
      throw new Error("expected deployment fault")
    }
    expect(result.failure.retryable).toBe(false)
    expect(result.failure.code).toBe("deployment")
  })

  it("fails immediately for persistent Custom Connection 401 after token handling", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(401, {
          error: "invalid_client",
          error_description: "Invalid client credentials",
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "auth",
    })
  })

  it("refreshes a cached token once after an accounting 401, then fails persistently", async () => {
    let tokenRequests = 0
    let invoiceGets = 0
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        tokenRequests += 1
        return jsonResponse(200, defaultToken)
      }
      if (request.url === "https://api.xero.com/connections") {
        return jsonResponse(200, defaultConnection)
      }
      if (isContactsGet(request) || isContactsPost(request)) {
        return jsonResponse(200, {
          Contacts: [{ ...defaultCreatedContact.Contacts[0], Addresses: [] }],
        })
      }
      if (isInvoicesGet(request)) {
        invoiceGets += 1
        if (invoiceGets === 1) {
          return jsonResponse(401, { Title: "Unauthorized" })
        }
        return jsonResponse(401, { Title: "Unauthorized" })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "auth",
    })
    expect(tokenRequests).toBe(2)
    expect(invoiceGets).toBe(2)
  })

  it("fails immediately for Custom Connection 403 permission failures", async () => {
    installFetch((request) => {
      const handled = successfulProvider(request)
      if (handled !== undefined && !isInvoicesPost(request)) {
        return handled
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(403, { Title: "Forbidden" })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "permission",
    })
  })

  for (const status of [405, 501] as const) {
    it(`tags HTTP ${String(status)} as a non-retryable unsupported operation`, async () => {
      installFetch((request) => {
        const handled = successfulProvider(request)
        if (handled !== undefined && !isInvoicesPost(request)) {
          return handled
        }
        if (isInvoicesPost(request)) {
          return jsonResponse(status, { Title: "Not Supported" })
        }
        return new Response("unhandled", { status: 500 })
      })

      await expectTaggedFailure(issueInvoice(), {
        retryable: false,
        code: "unsupported_operation",
      })
    })
  }

  it("treats 429 as retryable and waits Retry-After without a tight loop", async () => {
    const { requests } = installFetch((request) => {
      const handled = successfulProvider(request)
      if (handled !== undefined && !isInvoicesPost(request)) {
        return handled
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(
          429,
          { Title: "Too Many Requests" },
          {
            "Retry-After": "2",
          },
        )
      }
      return new Response("unhandled", { status: 500 })
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          issueInvoiceEffect().pipe(Effect.result),
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(liveLayer),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) {
      throw new Error("expected rate limit")
    }
    expect(result.failure.retryable).toBe(true)
    expect(result.failure.code).toBe("rate_limit")
    expect(result.failure.retryAfterSeconds).toBe(2)
    expect(requests.filter(isInvoicesPost)).toHaveLength(1)
  })

  it("tags 500 and 503 as retryable and reconciles before another create", async () => {
    let invoicePosts = 0
    const { requests } = installFetch((request) => {
      if (isInvoicesPost(request)) {
        invoicePosts += 1
        if (invoicePosts === 1) {
          return jsonResponse(503, { Title: "Service Unavailable" })
        }
        return jsonResponse(200, defaultInvoice)
      }
      const handled = successfulProvider(request)
      return handled ?? new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: true,
      code: "provider_server",
    })
    expect(requests.filter(isReferenceSearch).length).toBeGreaterThan(0)
    expect(requests.filter(isInvoicesPost)).toHaveLength(1)

    const second = await Effect.runPromise(issueInvoice())
    expect(`${second.invoiceNumber}`).toBe("INV-0100")
    expect(requests.filter(isReferenceSearch).length).toBeGreaterThan(1)
    expect(requests.filter(isInvoicesPost)).toHaveLength(2)
  })

  it("tags network failures as retryable", async () => {
    installFetch(() => {
      throw new TypeError("fetch failed")
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: true,
      code: "transport",
    })
  })

  it("tags timeouts as retryable", async () => {
    installFetch(() => {
      throw new DOMException("The operation was aborted.", "TimeoutError")
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: true,
      code: "timeout",
    })
  })

  it("fails immediately for a malformed token response without inventing identity", async () => {
    installFetch((request) => {
      if (request.url === "https://identity.xero.com/connect/token") {
        return jsonResponse(200, { token_type: "Bearer" })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "malformed_response",
    })
  })

  it.each(["not-json", "{}"])(
    "does not authorize a new write key from an unstructured HTTP 400 (%s)",
    async (body) => {
      installFetch((request) =>
        isInvoicesPost(request)
          ? new Response(body, { status: 400 })
          : (successfulProvider(request) ??
            new Response("unhandled", { status: 500 })),
      )
      await expectTaggedFailure(issueInvoice(), {
        retryable: false,
        code: "validation",
      })
    },
  )

  it("keeps validation failures non-retryable with field-scoped provider detail", async () => {
    installFetch((request) => {
      const handled = successfulProvider(request)
      if (handled !== undefined && !isInvoicesPost(request)) {
        return handled
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(400, {
          Type: "ValidationException",
          Elements: [
            {
              ValidationErrors: [{ Message: "The UnitAmount is invalid" }],
            },
          ],
        })
      }
      return new Response("unhandled", { status: 500 })
    })

    const error = await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "validation",
      fields: ["UnitAmount"],
      externalWriteRejected: true,
    })
    expect(error.message).toContain("UnitAmount")
    expect(error.message).not.toContain("Customhouse")
  })

  it("does not invent invoice identity from a malformed success payload", async () => {
    installFetch((request) => {
      const handled = successfulProvider(request)
      if (handled !== undefined && !isInvoicesPost(request)) {
        return handled
      }
      if (isInvoicesPost(request)) {
        return jsonResponse(200, { Invoices: [{ Status: "AUTHORISED" }] })
      }
      return new Response("unhandled", { status: 500 })
    })

    await expectTaggedFailure(issueInvoice(), {
      retryable: false,
      code: "malformed_response",
    })
  })
})
