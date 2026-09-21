import { Headers, HttpClient, HttpClientRequest } from "@effect/platform"
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { CurrentStepJobContext } from "@pf/process"
import {
  type ResolvedXeroContact,
  isContactNameConflict,
  resolveInvoiceContact,
} from "./contact-resolution"
import {
  XeroInvoiceError,
  xeroAuthError,
  xeroDeploymentError,
  xeroIdempotencyConflictError,
  xeroMalformedResponseError,
  xeroPermissionError,
  xeroProviderServerError,
  xeroRateLimitError,
  xeroTimeoutError,
  xeroUnknownItemCodeError,
  xeroUnsupportedOperationError,
  xeroValidationError,
} from "./errors"
import {
  isXeroIdempotencyConflictMessage,
  xeroDraftIdempotencyKey,
  xeroIdempotencyKey,
} from "./idempotency"
import {
  type IssueAuthorisedSalesInvoiceInput,
  type IssuedSalesInvoice,
  type ShippingAddress,
  XeroContactId,
  XeroInvoiceId,
  XeroInvoiceNumber,
  normalizeEmail,
} from "./identities"
import {
  type ReconcilableInvoice,
  decodeIssuedSalesInvoice,
  reconcileExistingInvoices,
  wireAmountToMoney,
} from "./invoice-reconciliation"
import {
  type DraftInvoiceResult,
  DraftSalesInvoice,
  XeroDraftInvoice,
  matchesInvoiceReference,
} from "./xero-draft-invoice"
import {
  mapHttpClientError,
  parseRetryAfterSeconds,
  waitForRetryAfter,
} from "./xero-http"
import { XeroInvoice } from "./xero-invoice"
import { type InvoiceDirectory, XeroInvoiceLookup } from "./xero-invoice-lookup"
import {
  type XeroAccess,
  type XeroAccessCache,
  makeXeroAccessCache,
  refreshAfterMsFromExpiresIn,
} from "./xero-token"
import {
  XeroConnectionsResponse,
  XeroContactsResponse,
  XeroErrorResponse,
  type XeroInvoiceWire,
  XeroInvoicesResponse,
  XeroTokenErrorResponse,
  XeroTokenResponse,
} from "./xero-wire"

export { XERO_TOKEN_REFRESH_BUFFER_MS } from "./xero-token"

const TOKEN_URL = "https://identity.xero.com/connect/token"
const CONNECTIONS_URL = "https://api.xero.com/connections"
const ACCOUNTING_URL = "https://api.xero.com/api.xro/2.0"
const DEFAULT_SCOPES = "accounting.invoices accounting.contacts"

export const XERO_DEFAULT_SCOPES = DEFAULT_SCOPES

export class XeroInvoiceConfig extends Context.Tag(
  "@processfocus/plugin-xero/XeroInvoiceConfig",
)<
  XeroInvoiceConfig,
  {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
    readonly scopes: string
  }
>() {}

const requireXeroInvoiceConfig = (config: {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  readonly scopes: string
}): Effect.Effect<typeof config, XeroInvoiceError> => {
  if (
    config.clientId.trim() === "" ||
    config.scopes.trim() === "" ||
    Redacted.value(config.clientSecret).trim() === ""
  ) {
    return Effect.fail(
      xeroDeploymentError(
        "Xero Custom Connection configuration is missing or malformed",
      ),
    )
  }
  return Effect.succeed(config)
}

export const XeroInvoiceConfigFromEnv = Layer.effect(
  XeroInvoiceConfig,
  Effect.gen(function* () {
    return yield* requireXeroInvoiceConfig({
      clientId: (yield* Config.string("XERO_CLIENT_ID")).trim(),
      clientSecret: yield* Config.redacted("XERO_CLIENT_SECRET"),
      scopes: (yield* Config.withDefault(
        Config.string("XERO_SCOPES"),
        DEFAULT_SCOPES,
      )).trim(),
    })
  }).pipe(
    Effect.mapError((error) =>
      error instanceof XeroInvoiceError
        ? error
        : xeroDeploymentError(
            "Xero Custom Connection configuration is missing or malformed",
          ),
    ),
  ),
)

const decodeJson = <A, I>(
  schema: Schema.Schema<A, I>,
  bodyText: string,
  message: string,
): Effect.Effect<A, XeroInvoiceError> =>
  Schema.decodeUnknown(Schema.parseJson(schema))(bodyText).pipe(
    Effect.mapError(() => xeroMalformedResponseError(message)),
  )

const validationMessages = (bodyText: string): readonly string[] => {
  const decoded = Schema.decodeUnknownOption(
    Schema.parseJson(XeroErrorResponse),
  )(bodyText)
  return Option.match(decoded, {
    onNone: () => [],
    onSome: (value) => [
      ...(value.Detail !== undefined ? [value.Detail] : []),
      ...(value.Message !== undefined ? [value.Message] : []),
      ...(value.Elements ?? []).flatMap((element) =>
        (element.ValidationErrors ?? []).flatMap((error) =>
          error.Message === undefined ? [] : [error.Message],
        ),
      ),
    ],
  })
}

const PROVIDER_FIELDS = [
  "ItemCode",
  "ContactID",
  "Contact",
  "Reference",
  "Date",
  "DueDate",
  "CurrencyCode",
  "UnitAmount",
  "Quantity",
  "Type",
  "Status",
  "LineAmountTypes",
  "Name",
  "EmailAddress",
] as const

const isUnknownItemMessage = (message: string): boolean => {
  const lower = message.toLowerCase()
  return lower.includes("item code") || lower.includes("itemcode")
}

const fieldsFromMessages = (messages: readonly string[]): readonly string[] => {
  const lowerMessages = messages.map((message) => message.toLowerCase())
  return PROVIDER_FIELDS.filter((field) => {
    const needle = field.toLowerCase()
    return lowerMessages.some(
      (message) =>
        message.includes(needle) ||
        message.includes(needle.replace("code", " code")),
    )
  })
}

const providerFailure = (
  status: number,
  bodyText: string,
  productSku: string,
): XeroInvoiceError => {
  if (status === 401) {
    return xeroAuthError("Xero Custom Connection authentication failed")
  }
  if (status === 403) {
    return xeroPermissionError(
      "Xero Custom Connection is missing required permissions",
    )
  }
  if (status === 405 || status === 501) {
    return xeroUnsupportedOperationError("Xero operation is not supported")
  }
  if (status >= 500) {
    return xeroProviderServerError(status)
  }

  const messages = validationMessages(bodyText)
  if (messages.some(isXeroIdempotencyConflictMessage)) {
    return xeroIdempotencyConflictError()
  }
  if (messages.some(isUnknownItemMessage)) {
    return xeroUnknownItemCodeError(productSku)
  }
  const contactNameConflict = messages.find(isContactNameConflict)
  if (contactNameConflict !== undefined) {
    return xeroValidationError(contactNameConflict)
  }
  if (messages[0] !== undefined) {
    const fields = fieldsFromMessages(messages)
    return xeroValidationError(messages[0], {
      ...(fields.length > 0 ? { fields } : {}),
    })
  }

  return xeroValidationError(`Xero request was rejected (${String(status)})`)
}

const tokenFailure = (status: number, bodyText: string): XeroInvoiceError => {
  if (status === 401 || status === 403) {
    return xeroAuthError("Xero Custom Connection authentication failed")
  }
  if (status >= 500) {
    return xeroProviderServerError(status)
  }

  const decoded = Schema.decodeUnknownOption(
    Schema.parseJson(XeroTokenErrorResponse),
  )(bodyText)
  const description = Option.match(decoded, {
    onNone: () => undefined,
    onSome: (value) => value.error_description,
  })
  return xeroAuthError(
    description ?? "Xero Custom Connection token request failed",
  )
}

interface XeroHttpResult {
  readonly status: number
  readonly bodyText: string
  readonly retryAfter: string | undefined
  readonly partial: boolean
}

const execute = (
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<XeroHttpResult, XeroInvoiceError> =>
  Effect.gen(function* () {
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError(mapHttpClientError))
    const bodyText = yield* response.text.pipe(
      Effect.mapError(mapHttpClientError),
    )
    return {
      status: response.status,
      bodyText,
      partial: Option.isSome(Headers.get(response.headers, "content-range")),
      retryAfter: Option.getOrUndefined(
        Headers.get(response.headers, "retry-after"),
      ),
    }
  })

const failRateLimited = (
  retryAfter: string | undefined,
): Effect.Effect<never, XeroInvoiceError> =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfter, nowMs)
    yield* waitForRetryAfter(retryAfterSeconds)
    return yield* xeroRateLimitError(retryAfterSeconds)
  })

const interpretXeroResult = (
  result: XeroHttpResult,
  productSku: string,
): Effect.Effect<XeroHttpResult, XeroInvoiceError> => {
  if (result.status === 429) {
    return failRateLimited(result.retryAfter)
  }
  if (result.status < 200 || result.status >= 300) {
    return Effect.fail(
      providerFailure(result.status, result.bodyText, productSku),
    )
  }
  return Effect.succeed(result)
}

const accountingRequest = (
  method: "GET" | "POST",
  path: string,
  accessToken: Redacted.Redacted<string>,
  tenantId: string,
  idempotencyKey?: string,
): HttpClientRequest.HttpClientRequest => {
  const url = `${ACCOUNTING_URL}${path}`
  const base =
    method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  const headers = base.pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeader("Xero-tenant-id", tenantId),
    HttpClientRequest.setHeader("Accept", "application/json"),
  )
  if (idempotencyKey === undefined) {
    return headers
  }
  return headers.pipe(
    HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
  )
}

const xeroStreetAddress = (shipping: ShippingAddress) => ({
  AddressType: "STREET",
  AddressLine1: shipping.line1,
  ...(shipping.line2 !== undefined && { AddressLine2: shipping.line2 }),
  City: shipping.city,
  ...(shipping.region !== undefined && { Region: shipping.region }),
  ...(shipping.postalCode !== undefined && {
    PostalCode: shipping.postalCode,
  }),
  ...(shipping.country !== undefined && { Country: shipping.country }),
})

export const xeroContactWritePayload = (
  input: IssueAuthorisedSalesInvoiceInput,
  name: string,
  contactId: string | undefined,
) => ({
  Contacts: [
    {
      ...(contactId !== undefined && { ContactID: contactId }),
      Name: name,
      EmailAddress: input.customer.email,
      Addresses: [xeroStreetAddress(input.shippingAddress)],
    },
  ],
})

export const xeroInvoiceWritePayload = (
  contactId: string,
  input: IssueAuthorisedSalesInvoiceInput,
) => ({
  Invoices: [
    {
      Type: "ACCREC",
      Status: "AUTHORISED",
      Contact: { ContactID: contactId },
      Date: input.date,
      DueDate: input.dueDate,
      LineAmountTypes: "Inclusive",
      CurrencyCode: input.currency,
      Reference: input.reference,
      LineItems: [
        {
          ItemCode: input.productSku,
          Description: input.productSku,
          Quantity: 1,
          UnitAmount: input.agreedPrice,
        },
      ],
    },
  ],
})

const xeroWhereEquals = (field: string, value: string): string =>
  `${field}=="${value.replaceAll('"', '""')}"`

const requestAccessToken = (
  httpClient: HttpClient.HttpClient,
  config: Context.Tag.Service<typeof XeroInvoiceConfig>,
): Effect.Effect<
  {
    readonly accessToken: Redacted.Redacted<string>
    readonly expiresIn: number
  },
  XeroInvoiceError
> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.basicAuth(config.clientId, config.clientSecret),
      HttpClientRequest.bodyUrlParams({
        grant_type: "client_credentials",
        scope: config.scopes,
      }),
    )
    const result = yield* execute(httpClient, request)
    if (result.status === 429) {
      return yield* failRateLimited(result.retryAfter)
    }
    if (result.status < 200 || result.status >= 300) {
      return yield* tokenFailure(result.status, result.bodyText)
    }
    const token = yield* decodeJson(
      XeroTokenResponse,
      result.bodyText,
      "Malformed Xero token response",
    )
    return {
      accessToken: Redacted.make(token.access_token),
      expiresIn: token.expires_in,
    }
  })

const requestTenantId = (
  httpClient: HttpClient.HttpClient,
  accessToken: Redacted.Redacted<string>,
): Effect.Effect<string, XeroInvoiceError> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(CONNECTIONS_URL).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("Accept", "application/json"),
    )
    const result = yield* execute(httpClient, request)
    if (result.status === 429) {
      return yield* failRateLimited(result.retryAfter)
    }
    if (result.status < 200 || result.status >= 300) {
      return yield* providerFailure(result.status, result.bodyText, "")
    }
    const connections = yield* decodeJson(
      XeroConnectionsResponse,
      result.bodyText,
      "Malformed Xero connections response",
    )
    if (connections.length === 0) {
      return yield* xeroAuthError("Xero Custom Connection has no organisation")
    }
    if (connections.length !== 1 || connections[0] === undefined) {
      return yield* xeroAuthError(
        "Xero Custom Connection must be linked to exactly one organisation",
      )
    }
    return connections[0].tenantId
  })

const fetchXeroAccess = (
  httpClient: HttpClient.HttpClient,
  config: Context.Tag.Service<typeof XeroInvoiceConfig>,
): Effect.Effect<XeroAccess, XeroInvoiceError> =>
  Effect.gen(function* () {
    const token = yield* requestAccessToken(httpClient, config)
    const tenantId = yield* requestTenantId(httpClient, token.accessToken)
    const nowMs = yield* Clock.currentTimeMillis
    return {
      accessToken: token.accessToken,
      tenantId,
      refreshAfterMs: refreshAfterMsFromExpiresIn(nowMs, token.expiresIn),
    }
  })

const sendAccounting = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  build: (current: XeroAccess) => HttpClientRequest.HttpClientRequest,
  productSku: string,
): Effect.Effect<XeroHttpResult, XeroInvoiceError> =>
  Effect.gen(function* () {
    const firstAccess = yield* access.get()
    const first = yield* execute(httpClient, build(firstAccess))
    if (first.status !== 401) {
      return yield* interpretXeroResult(first, productSku)
    }
    yield* access.invalidate()
    const secondAccess = yield* access.get()
    const second = yield* execute(httpClient, build(secondAccess))
    return yield* interpretXeroResult(second, productSku)
  })

const findContacts = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  where: string,
  matches: (
    contact: (typeof XeroContactsResponse.Type)["Contacts"][number],
  ) => boolean,
): Effect.Effect<readonly ResolvedXeroContact[], XeroInvoiceError> =>
  Effect.gen(function* () {
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "GET",
          `/Contacts?where=${encodeURIComponent(where)}`,
          current.accessToken,
          current.tenantId,
        ),
      "",
    )
    const decoded = yield* decodeJson(
      XeroContactsResponse,
      result.bodyText,
      "Malformed Xero contact response",
    )
    return decoded.Contacts.filter(matches).map((contact) => ({
      contactId: contact.ContactID,
      ...(contact.Name !== undefined && { name: contact.Name }),
      ...(contact.EmailAddress !== undefined && {
        email: contact.EmailAddress,
      }),
    }))
  })

const writeContact = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  input: IssueAuthorisedSalesInvoiceInput,
  name: string,
  contactId: string | undefined,
  idempotencyKey: string,
): Effect.Effect<ResolvedXeroContact, XeroInvoiceError> =>
  Effect.gen(function* () {
    const payload = xeroContactWritePayload(input, name, contactId)
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "POST",
          "/Contacts",
          current.accessToken,
          current.tenantId,
          idempotencyKey,
        ).pipe(HttpClientRequest.bodyUnsafeJson(payload)),
      input.productSku,
    )
    const decoded = yield* decodeJson(
      XeroContactsResponse,
      result.bodyText,
      "Malformed Xero contact response",
    )
    const written = decoded.Contacts[0]
    if (decoded.Contacts.length !== 1 || written === undefined) {
      return yield* xeroMalformedResponseError(
        "Malformed Xero contact response",
      )
    }
    yield* Effect.log(
      contactId === undefined ? "Created Xero contact" : "Updated Xero contact",
    ).pipe(
      Effect.annotateLogs({
        reference: input.reference,
        contactId: written.ContactID,
        customerName: input.customer.name,
        customerEmail: input.customer.email,
      }),
    )
    return {
      contactId: written.ContactID,
      ...(written.Name !== undefined && { name: written.Name }),
      ...(written.EmailAddress !== undefined && {
        email: written.EmailAddress,
      }),
    }
  })

const toReconcilableInvoice = (
  invoice: typeof XeroInvoiceWire.Type,
): ReconcilableInvoice => {
  const line = invoice.LineItems?.[0]
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber,
    type: invoice.Type ?? "",
    status: invoice.Status,
    currency: invoice.CurrencyCode ?? "",
    date: invoice.Date ?? "",
    dueDate: invoice.DueDate ?? "",
    contactId: invoice.Contact?.ContactID ?? "",
    itemCode: line?.ItemCode ?? "",
    unitAmount: wireAmountToMoney(line?.UnitAmount) ?? "",
    total: wireAmountToMoney(invoice.Total) ?? "",
    lineCount: invoice.LineItems?.length ?? 0,
  }
}

const findInvoicesByReference = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  reference: string,
): Effect.Effect<readonly ReconcilableInvoice[], XeroInvoiceError> =>
  Effect.gen(function* () {
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "GET",
          `/Invoices?where=${encodeURIComponent(xeroWhereEquals("Reference", reference))}`,
          current.accessToken,
          current.tenantId,
        ),
      "",
    )
    const decoded = yield* decodeJson(
      XeroInvoicesResponse,
      result.bodyText,
      "Malformed Xero invoice response",
    )
    return decoded.Invoices.filter(
      (invoice) => invoice.Reference === reference,
    ).map(toReconcilableInvoice)
  })

const createInvoice = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  contactId: string,
  input: IssueAuthorisedSalesInvoiceInput,
  idempotencyKey: string,
): Effect.Effect<IssuedSalesInvoice, XeroInvoiceError> =>
  Effect.gen(function* () {
    const payload = xeroInvoiceWritePayload(contactId, input)
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "POST",
          "/Invoices",
          current.accessToken,
          current.tenantId,
          idempotencyKey,
        ).pipe(
          HttpClientRequest.appendUrlParam("SummarizeErrors", "true"),
          HttpClientRequest.bodyUnsafeJson(payload),
        ),
      input.productSku,
    )
    const decoded = yield* decodeJson(
      XeroInvoicesResponse,
      result.bodyText,
      "Malformed Xero invoice response",
    )
    const invoice = decoded.Invoices[0]
    if (decoded.Invoices.length !== 1 || invoice === undefined) {
      return yield* xeroMalformedResponseError(
        "Malformed Xero invoice response",
      )
    }
    if (invoice.Status !== "AUTHORISED") {
      return yield* xeroMalformedResponseError(
        "Xero invoice was not created in AUTHORISED state",
      )
    }
    const issued = yield* decodeIssuedSalesInvoice(
      invoice.InvoiceID,
      invoice.InvoiceNumber,
    )
    yield* Effect.log("Issued Xero Sales Invoice").pipe(
      Effect.annotateLogs({
        reference: input.reference,
        invoiceId: issued.invoiceId,
        invoiceNumber: issued.invoiceNumber,
        customerName: input.customer.name,
        customerEmail: input.customer.email,
        productSku: input.productSku,
        contactId,
      }),
    )
    return issued
  })

const logInvoiceFailure = (
  input: IssueAuthorisedSalesInvoiceInput,
  error: XeroInvoiceError,
): Effect.Effect<void> =>
  Effect.logWarning("Xero Sales Invoice failed").pipe(
    Effect.annotateLogs({
      reference: input.reference,
      customerName: input.customer.name,
      customerEmail: input.customer.email,
      code: error.code ?? "unknown",
      retryable: error.retryable,
    }),
  )

export const XeroInvoiceLive = Layer.effect(
  XeroInvoice,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
    const access = yield* makeXeroAccessCache(
      fetchXeroAccess(httpClient, config),
    )

    const issueAuthorisedSalesInvoice = Effect.fn(
      "XeroInvoice.issueAuthorisedSalesInvoice",
    )(function* (input: IssueAuthorisedSalesInvoiceInput) {
      return yield* Effect.gen(function* () {
        const { todoId } = yield* CurrentStepJobContext
        const contactId = yield* resolveInvoiceContact(
          {
            findByName: (name) =>
              findContacts(
                httpClient,
                access,
                xeroWhereEquals("Name", name),
                (contact) => contact.Name === name,
              ),
            findByEmail: (email) =>
              findContacts(
                httpClient,
                access,
                xeroWhereEquals("EmailAddress", normalizeEmail(email)),
                (contact) =>
                  contact.EmailAddress !== undefined &&
                  normalizeEmail(contact.EmailAddress) ===
                    normalizeEmail(email),
              ),
            create: (invoiceInput, name, idempotencyKey) =>
              writeContact(
                httpClient,
                access,
                invoiceInput,
                name,
                undefined,
                idempotencyKey,
              ),
            update: (contact, invoiceInput, idempotencyKey) =>
              writeContact(
                httpClient,
                access,
                invoiceInput,
                invoiceInput.customer.name,
                contact.contactId,
                idempotencyKey,
              ),
          },
          input,
          todoId,
        )
        const existing = yield* findInvoicesByReference(
          httpClient,
          access,
          input.reference,
        )
        const reconciled = yield* reconcileExistingInvoices(
          existing,
          input,
          contactId,
        )
        if (reconciled !== undefined) {
          return reconciled
        }
        return yield* createInvoice(
          httpClient,
          access,
          contactId,
          input,
          xeroIdempotencyKey(todoId, "invoice.create"),
        )
      }).pipe(Effect.tapError((error) => logInvoiceFailure(input, error)))
    })

    return { issueAuthorisedSalesInvoice }
  }),
)

const DirectoryContact = Schema.Struct({
  ContactID: XeroContactId,
  Name: Schema.String,
  ContactStatus: Schema.Literal("ACTIVE", "ARCHIVED", "GDPRREQUEST"),
  EmailAddress: Schema.optionalWith(Schema.String, { nullable: true }),
  ContactPersons: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        EmailAddress: Schema.optionalWith(Schema.String, { nullable: true }),
        IncludeInEmails: Schema.optionalWith(Schema.Boolean, {
          nullable: true,
        }),
      }),
    ),
    { nullable: true },
  ),
})
const DirectoryInvoice = Schema.Struct({
  InvoiceID: XeroInvoiceId,
  InvoiceNumber: XeroInvoiceNumber,
  Type: Schema.Literal("ACCREC"),
  Status: Schema.String,
  Contact: Schema.Struct({ ContactID: XeroContactId }),
  Reference: Schema.String,
})

const enabledInvoiceEmails = (
  contact: typeof DirectoryContact.Type,
): readonly string[] => [
  ...new Set(
    [
      contact.EmailAddress,
      ...(contact.ContactPersons ?? [])
        .filter((person) => person.IncludeInEmails === true)
        .map((person) => person.EmailAddress),
    ].flatMap((email) =>
      email ? email.split(/[;,]/).map(normalizeEmail).filter(Boolean) : [],
    ),
  ),
]

/** Read-only companion: shares authentication/error handling, never writes. */
export const XeroInvoiceLookupLive = Layer.effect(
  XeroInvoiceLookup,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
    const access = yield* makeXeroAccessCache(
      fetchXeroAccess(httpClient, config),
    )

    const readPages = <A, I>(
      path: string,
      schema: Schema.Schema<A, I>,
      rows: (value: A) => readonly { readonly id: string }[],
    ): Effect.Effect<readonly A[], XeroInvoiceError> =>
      Effect.gen(function* () {
        const pages: A[] = []
        const seen = new Set<string>()
        for (let page = 1; page <= 1000; page++) {
          const result = yield* sendAccounting(
            httpClient,
            access,
            (current) =>
              accountingRequest(
                "GET",
                `${path}&page=${page}&pageSize=100`,
                current.accessToken,
                current.tenantId,
              ),
            "",
          )
          // A partial or malformed response must never imply absence of an invoice.
          if (result.status !== 200 || result.partial)
            return yield* xeroMalformedResponseError(
              "Incomplete Xero invoice directory response",
            )
          const decoded = yield* decodeJson(
            schema,
            result.bodyText,
            "Malformed Xero invoice directory response",
          )
          const items = rows(decoded)
          for (const item of items) {
            if (seen.has(item.id))
              return yield* xeroMalformedResponseError(
                "Repeated Xero directory page or identity",
              )
            seen.add(item.id)
          }
          pages.push(decoded)
          if (items.length < 100) return pages
        }
        return yield* xeroMalformedResponseError(
          "Xero directory pagination limit exceeded",
        )
      })

    const readDirectory = (
      reference: string,
      previousReference?: string,
    ): Effect.Effect<InvoiceDirectory, XeroInvoiceError> =>
      Effect.gen(function* () {
        const text = yield* Schema.decodeUnknown(
          Schema.Trim.pipe(Schema.minLength(1)),
        )(reference).pipe(
          Effect.mapError(() =>
            xeroValidationError("An invoice reference is required"),
          ),
        )
        const references = yield* Schema.decodeUnknown(
          Schema.Array(Schema.Trim.pipe(Schema.minLength(1))),
        )(
          previousReference === undefined ? [text] : [text, previousReference],
        ).pipe(
          Effect.mapError(() =>
            xeroValidationError("Valid invoice references are required"),
          ),
        )
        const contactPages = yield* readPages(
          "/Contacts?includeArchived=true",
          Schema.Struct({ Contacts: Schema.Array(DirectoryContact) }),
          (page) => page.Contacts.map((contact) => ({ id: contact.ContactID })),
        )
        const where = `Type=="ACCREC"&&(${[...new Set(references)].map((value) => `Reference.Contains("${value.replaceAll('"', '""')}")`).join("||")})`
        const invoicePages = yield* readPages(
          `/Invoices?where=${encodeURIComponent(where)}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED`,
          Schema.Struct({ Invoices: Schema.Array(DirectoryInvoice) }),
          (page) => page.Invoices.map((invoice) => ({ id: invoice.InvoiceID })),
        )
        return {
          contacts: contactPages.flatMap((page) =>
            page.Contacts.map((contact) => ({
              contactId: contact.ContactID,
              name: contact.Name,
              active: contact.ContactStatus === "ACTIVE",
              emails: [
                ...new Set(
                  [
                    contact.EmailAddress,
                    ...(contact.ContactPersons ?? []).map(
                      (person) => person.EmailAddress,
                    ),
                  ].flatMap((email) =>
                    email
                      ? email.split(/[;,]/).map(normalizeEmail).filter(Boolean)
                      : [],
                  ),
                ),
              ],
              invoiceRecipientEmails: enabledInvoiceEmails(contact),
            })),
          ),
          invoices: invoicePages.flatMap((page) =>
            page.Invoices.map((invoice) => ({
              invoiceId: invoice.InvoiceID,
              invoiceNumber: invoice.InvoiceNumber,
              contactId: invoice.Contact.ContactID,
              reference: invoice.Reference,
              status: invoice.Status,
            })),
          ),
        }
      })
    return { readDirectory }
  }),
)

const CreatedDraftWire = Schema.Struct({
  ...DirectoryInvoice.fields,
  Status: Schema.Literal("DRAFT"),
  CurrencyCode: Schema.Literal("NZD"),
  LineAmountTypes: Schema.Literal("Inclusive"),
  DateString: Schema.String,
  DueDateString: Schema.String,
  Total: Schema.Number,
  TotalTax: Schema.Number,
  SubTotal: Schema.Number,
  LineItems: Schema.Array(
    Schema.Struct({
      ItemCode: Schema.String,
      Description: Schema.String,
      Quantity: Schema.Number,
      UnitAmount: Schema.Number,
      LineAmount: Schema.Number,
      TaxAmount: Schema.Number,
      TaxType: Schema.String,
      Tracking: Schema.optional(
        Schema.Array(
          Schema.Struct({
            Name: Schema.String,
            Option: Schema.String,
          }),
        ),
      ),
    }),
  ),
})
const ContactInvoiceWire = Schema.Struct({
  ...DirectoryInvoice.fields,
  Reference: Schema.optionalWith(Schema.String, { nullable: true }),
})

export const XeroDraftInvoiceLive = Layer.effect(
  XeroDraftInvoice,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
    const access = yield* makeXeroAccessCache(
      fetchXeroAccess(httpClient, config),
    )
    const serial = yield* Effect.makeSemaphore(1)
    // Pace the lookup/write pair below the tenant's minute budget. Xero's
    // Retry-After handling still applies when other clients share the tenant.
    const request = (
      build: (current: XeroAccess) => HttpClientRequest.HttpClientRequest,
    ) =>
      Effect.sleep("2 seconds").pipe(
        Effect.zipRight(
          sendAccounting(httpClient, access, build, "").pipe(
            Effect.timeoutFail({
              duration: "30 seconds",
              onTimeout: () =>
                xeroTimeoutError(
                  "Xero draft request timed out; reconcile before retry",
                ),
            }),
          ),
        ),
      )

    const createIfAbsent = (
      input: DraftSalesInvoice,
    ): Effect.Effect<DraftInvoiceResult, XeroInvoiceError> =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          const invoice = yield* Schema.decodeUnknown(DraftSalesInvoice)(
            input,
          ).pipe(
            Effect.mapError(() =>
              xeroValidationError(
                "Invalid draft invoice input or inconsistent amounts",
              ),
            ),
          )
          const duplicateReference =
            invoice.duplicateReference ?? invoice.reference
          // Read this contact's invoices, not a potentially stale batch snapshot.
          // Filtering references locally also handles whitespace/case and suffixes.
          const matches: (typeof ContactInvoiceWire.Type)[] = []
          const seen = new Set<string>()
          let complete = false
          for (let page = 1; page <= 1000; page++) {
            const response = yield* request((current) =>
              accountingRequest(
                "GET",
                `/Invoices?ContactIDs=${invoice.contactId}&where=${encodeURIComponent('Type=="ACCREC"')}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=${page}&pageSize=100`,
                current.accessToken,
                current.tenantId,
              ),
            )
            if (response.status !== 200 || response.partial)
              return yield* xeroMalformedResponseError(
                "Incomplete draft duplicate check",
              )
            const decoded = yield* decodeJson(
              Schema.Struct({ Invoices: Schema.Array(ContactInvoiceWire) }),
              response.bodyText,
              "Malformed draft duplicate check",
            )
            for (const existing of decoded.Invoices) {
              if (
                seen.has(existing.InvoiceID) ||
                existing.Contact.ContactID !== invoice.contactId
              )
                return yield* xeroMalformedResponseError(
                  "Repeated identity or unrelated contact in draft duplicate check",
                )
              seen.add(existing.InvoiceID)
              if (
                matchesInvoiceReference(
                  existing.Reference ?? "",
                  duplicateReference,
                )
              )
                matches.push(existing)
            }
            if (decoded.Invoices.length < 100) {
              complete = true
              break
            }
          }
          if (!complete)
            return yield* xeroMalformedResponseError(
              "Draft duplicate-check pagination limit exceeded",
            )
          const [first, ...rest] = matches
          if (first)
            return {
              kind: "skipped-existing",
              existingInvoices: [
                {
                  invoiceId: first.InvoiceID,
                  invoiceNumber: first.InvoiceNumber,
                  status: first.Status,
                },
                ...rest.map((value) => ({
                  invoiceId: value.InvoiceID,
                  invoiceNumber: value.InvoiceNumber,
                  status: value.Status,
                })),
              ],
            }

          if (!invoice.expectedRecipientEmails?.length)
            return yield* xeroValidationError(
              "Draft recipient intent is missing; prepare the invoice again before creating it",
            )
          const contactResponse = yield* request((current) =>
            accountingRequest(
              "GET",
              `/Contacts?IDs=${invoice.contactId}`,
              current.accessToken,
              current.tenantId,
            ),
          )
          if (contactResponse.status !== 200 || contactResponse.partial)
            return yield* xeroMalformedResponseError(
              "Incomplete draft recipient check",
            )
          const decodedContact = yield* decodeJson(
            Schema.Struct({ Contacts: Schema.Array(DirectoryContact) }),
            contactResponse.bodyText,
            "Malformed draft recipient check",
          )
          const contact = decodedContact.Contacts[0]
          if (
            decodedContact.Contacts.length !== 1 ||
            !contact ||
            contact.ContactID !== invoice.contactId
          )
            return yield* xeroMalformedResponseError(
              "Unexpected contact in draft recipient check",
            )
          const expectedEmails = new Set(
            invoice.expectedRecipientEmails.map(normalizeEmail),
          )
          const actualEmails = new Set(enabledInvoiceEmails(contact))
          if (
            contact.ContactStatus !== "ACTIVE" ||
            expectedEmails.size !== actualEmails.size ||
            [...expectedEmails].some((email) => !actualEmails.has(email))
          ) {
            return yield* xeroValidationError(
              "Xero invoice recipients do not match the bill payers; review the contact before creating a draft",
            )
          }
          const currentAccess = yield* access.get()
          const key = xeroDraftIdempotencyKey(
            currentAccess.tenantId,
            invoice.contactId,
            duplicateReference,
          )
          const response = yield* request((current) =>
            accountingRequest(
              "POST",
              "/Invoices",
              current.accessToken,
              current.tenantId,
              key,
            ).pipe(
              HttpClientRequest.appendUrlParam("SummarizeErrors", "true"),
              HttpClientRequest.bodyUnsafeJson({
                Invoices: [
                  {
                    Type: "ACCREC",
                    Status: "DRAFT",
                    Contact: { ContactID: invoice.contactId },
                    Reference: invoice.reference,
                    Date: invoice.date,
                    DueDate: invoice.dueDate,
                    CurrencyCode: invoice.currency,
                    LineAmountTypes: invoice.lineAmountType,
                    LineItems: invoice.lines.map((line) => ({
                      ItemCode: line.itemCode,
                      Description: line.description,
                      Quantity: line.quantity,
                      UnitAmount: line.unitAmountCents / 100,
                      LineAmount: line.lineAmountCents / 100,
                      TaxAmount: line.taxCents / 100,
                      TaxType: line.taxType,
                      ...(line.tracking && {
                        Tracking: line.tracking.map((tracking) => ({
                          Name: tracking.category,
                          Option: tracking.option,
                        })),
                      }),
                    })),
                  },
                ],
              }),
            ),
          )
          const decoded = yield* decodeJson(
            Schema.Struct({ Invoices: Schema.Array(CreatedDraftWire) }),
            response.bodyText,
            "Malformed Xero draft creation response",
          )
          const created = decoded.Invoices[0]
          if (
            decoded.Invoices.length !== 1 ||
            !created ||
            created.Contact.ContactID !== invoice.contactId ||
            created.Reference !== invoice.reference ||
            created.DateString.slice(0, 10) !== invoice.date ||
            created.DueDateString.slice(0, 10) !== invoice.dueDate ||
            created.Total !== invoice.totalCents / 100 ||
            created.TotalTax !== invoice.taxCents / 100 ||
            created.SubTotal !== invoice.subtotalCents / 100 ||
            created.LineItems.length !== invoice.lines.length ||
            created.LineItems.some((line, index) => {
              const expected = invoice.lines[index]
              return (
                !expected ||
                line.ItemCode !== expected.itemCode ||
                line.Description !== expected.description ||
                line.Quantity !== expected.quantity ||
                line.UnitAmount !== expected.unitAmountCents / 100 ||
                line.LineAmount !== expected.lineAmountCents / 100 ||
                line.TaxAmount !== expected.taxCents / 100 ||
                line.TaxType !== expected.taxType ||
                (line.Tracking ?? []).length !==
                  (expected.tracking ?? []).length ||
                (expected.tracking ?? []).some(
                  (tracking) =>
                    !line.Tracking?.some(
                      (actual) =>
                        actual.Name === tracking.category &&
                        actual.Option === tracking.option,
                    ),
                )
              )
            })
          )
            return yield* xeroMalformedResponseError(
              "Created Xero draft does not match the requested invoice identity, lines or amounts",
            )
          yield* Effect.log("Created Xero draft invoice").pipe(
            Effect.annotateLogs({
              invoiceId: created.InvoiceID,
              invoiceNumber: created.InvoiceNumber,
              contactId: invoice.contactId,
              reference: invoice.reference,
              totalCents: invoice.totalCents,
            }),
          )
          return {
            kind: "created-draft",
            invoiceId: created.InvoiceID,
            invoiceNumber: created.InvoiceNumber,
            status: "DRAFT",
          }
        }),
      )
    return { createIfAbsent }
  }),
)
