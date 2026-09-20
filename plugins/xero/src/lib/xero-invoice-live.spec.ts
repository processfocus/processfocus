import { FetchHttpClient } from "@effect/platform"
import {
  ConfigProvider,
  Effect,
  Either,
  Fiber,
  Layer,
  Logger,
  Schema,
  TestClock,
  TestContext,
} from "effect"
import { CurrentStepJobContext } from "@pf/process"
import { xeroIdempotencyKey } from "./idempotency"
import { IssueAuthorisedSalesInvoiceInput } from "./identities"
import { XeroInvoice } from "./xero-invoice"
import {
  XERO_TOKEN_REFRESH_BUFFER_MS,
  XeroInvoiceConfigFromEnv,
  XeroInvoiceLive,
} from "./xero-invoice-live"
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
  productSku: "TBS-100",
  agreedPrice: "100.00",
  currency: "NZD",
  reference: "ORD-1001",
  date: "2026-03-15",
  dueDate: "2026-03-15",
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
  FetchHttpClient.layer,
)

const configProvider = ConfigProvider.fromMap(
  new Map([
    ["XERO_CLIENT_ID", "xero-client-id"],
    ["XERO_CLIENT_SECRET", "xero-client-secret"],
  ]),
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
    Effect.withConfigProvider(configProvider),
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
  },
) => {
  const result = await Effect.runPromise(effect.pipe(Effect.either))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isRight(result)) {
    throw new Error("expected XeroInvoiceError")
  }
  expect(result.left.retryable).toBe(expected.retryable)
  expect(result.left.code).toBe(expected.code)
  if (expected.fields !== undefined) {
    expect(result.left.fields).toEqual(expected.fields)
  }
  expect(String(result.left)).not.toContain("Customhouse")
  expect(String(result.left)).not.toContain("xero-access-token")
  expect(String(result.left)).not.toContain("xero-client-secret")
  expect(String(result.left)).not.toContain("Bearer ")
  return result.left
}

describe("XeroInvoiceLive", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

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
    expect(contactBody.Contacts[0]?.Addresses).toHaveLength(1)
    expect(contactBody.Contacts[0]?.Addresses[0]?.AddressType).toBe("STREET")
    expect(contactBody.Contacts[0]?.Addresses[0]?.AddressLine1).toBe(
      "10 Customhouse Quay",
    )

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
          Description: string
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
        Description: "TBS-100",
        Quantity: 1,
        UnitAmount: "100.00",
      },
    ])
  })

  it("updates a unique email match with current details and STREET only", async () => {
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
    expect(contactBody.Contacts[0]?.Addresses).toHaveLength(1)
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
  })

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
    expect(requests.some(isContactsPost)).toBe(false)
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
    })
  })

  it("logs operational identity without shipping or secrets", async () => {
    const logs: string[] = []
    const capturingLogger = Logger.make(({ message, annotations }) => {
      logs.push(
        `${String(message)} ${JSON.stringify(Object.fromEntries(annotations))}`,
      )
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
      issueInvoice().pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger)),
      ),
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
    expect(requests.some(isInvoicesPost)).toBe(false)
  })

  it("fails when an existing Reference invoice has conflicting intent", async () => {
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
        Effect.withConfigProvider(configProvider),
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
        Effect.withConfigProvider(configProvider),
        Effect.provide(TestContext.TestContext),
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
        Effect.withConfigProvider(configProvider),
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
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
        Effect.either,
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) {
      throw new Error("expected deployment fault")
    }
    expect(result.left.retryable).toBe(false)
    expect(result.left.code).toBe("deployment")
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
        return jsonResponse(200, defaultCreatedContact)
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
        const fiber = yield* Effect.fork(
          issueInvoiceEffect().pipe(Effect.either),
        )
        yield* Effect.yieldNow()
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(liveLayer),
        Effect.withConfigProvider(configProvider),
        Effect.provide(TestContext.TestContext),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) {
      throw new Error("expected rate limit")
    }
    expect(result.left.retryable).toBe(true)
    expect(result.left.code).toBe("rate_limit")
    expect(result.left.retryAfterSeconds).toBe(2)
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
