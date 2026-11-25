import { createHash, randomUUID } from "node:crypto"
import { readConfiguration } from "@processfocus/runtime"
import {
  BigDecimal,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  SchemaGetter,
  Semaphore,
} from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"
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
import { XeroConfiguration } from "./xero-configuration"
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
import {
  type CancelSalesInvoiceInput,
  type CancelledSalesInvoice,
  XeroInvoiceCancellation,
  decodeCancelSalesInvoiceInput,
} from "./xero-invoice-cancellation"
import { type InvoiceDirectory, XeroInvoiceLookup } from "./xero-invoice-lookup"
import {
  type SalesItemResult,
  XeroInvoicePreparation,
} from "./xero-invoice-preparation"
import {
  CreatedRepeatedDraft,
  RepeatedDraftSalesInvoice,
  XeroRepeatedDraftInvoice,
} from "./xero-repeated-draft-invoice"
import {
  type XeroAccess,
  type XeroAccessCache,
  makeXeroAccessCache,
  refreshAfterMsFromExpiresIn,
} from "./xero-token"
import {
  XeroConnectionsResponse,
  XeroContactDetailsResponse,
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

export { XERO_DEFAULT_SCOPES } from "./xero-configuration"

export class XeroInvoiceConfig extends Context.Service<
  XeroInvoiceConfig,
  {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
    readonly scopes: string
  }
>()("@processfocus/plugin-xero/XeroInvoiceConfig") {}

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
  readConfiguration(XeroConfiguration).pipe(
    Effect.mapError(() =>
      xeroDeploymentError(
        "Xero Custom Connection configuration is missing or malformed",
      ),
    ),
  ),
)

const decodeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  bodyText: string,
  message: string,
): Effect.Effect<A, XeroInvoiceError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(bodyText).pipe(
    Effect.mapError(() => xeroMalformedResponseError(message)),
  )

const validationMessages = (bodyText: string): readonly string[] => {
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(XeroErrorResponse),
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
    Schema.fromJsonString(XeroTokenErrorResponse),
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
  invoiceWrite = false,
): Effect.Effect<XeroHttpResult, XeroInvoiceError> => {
  if (result.status === 429) {
    return failRateLimited(result.retryAfter)
  }
  if (result.status < 200 || result.status >= 300) {
    const error = providerFailure(result.status, result.bodyText, productSku)
    return Effect.fail(
      invoiceWrite &&
        result.status === 400 &&
        validationMessages(result.bodyText).length > 0 &&
        (error.code === "validation" || error.code === "unknown_item_code")
        ? new XeroInvoiceError({
            ...error,
            message: error.message,
            externalWriteRejected: true,
          })
        : error,
    )
  }
  return Effect.succeed(result)
}

const accountingRequest = (
  method: "GET" | "POST" | "PUT",
  path: string,
  accessToken: Redacted.Redacted<string>,
  tenantId: string,
  idempotencyKey?: string,
): HttpClientRequest.HttpClientRequest => {
  const url = `${ACCOUNTING_URL}${path}`
  const base = HttpClientRequest.make(method)(url)
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
  defaultBilling: boolean,
) => ({
  Contacts: [
    {
      ...(contactId !== undefined && { ContactID: contactId }),
      Name: name,
      EmailAddress: input.customer.email,
      Addresses: [
        xeroStreetAddress(input.shippingAddress),
        ...(defaultBilling
          ? [
              {
                ...xeroStreetAddress(input.shippingAddress),
                AddressType: "POBOX",
              },
            ]
          : []),
      ],
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
      LineItems: input.lines.map((line) => ({
        ItemCode: line.productSku,
        // Let Xero snapshot the Item's sales description onto the invoice.
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
      })),
    },
  ],
})

const xeroWhereEquals = (field: string, value: string): string =>
  `${field}=="${value.replaceAll('"', '""')}"`

const requestAccessToken = (
  httpClient: HttpClient.HttpClient,
  config: Context.Service.Shape<typeof XeroInvoiceConfig>,
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
  config: Context.Service.Shape<typeof XeroInvoiceConfig>,
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
  invoiceWrite = false,
): Effect.Effect<XeroHttpResult, XeroInvoiceError> =>
  Effect.gen(function* () {
    const firstAccess = yield* access.get()
    const first = yield* execute(httpClient, build(firstAccess))
    if (first.status !== 401) {
      return yield* interpretXeroResult(first, productSku, invoiceWrite)
    }
    yield* access.invalidate()
    const secondAccess = yield* access.get()
    const second = yield* execute(httpClient, build(secondAccess))
    return yield* interpretXeroResult(second, productSku, invoiceWrite)
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
    let defaultBilling = true
    if (contactId !== undefined) {
      const detail = yield* sendAccounting(
        httpClient,
        access,
        (current) =>
          accountingRequest(
            "GET",
            `/Contacts/${contactId}`,
            current.accessToken,
            current.tenantId,
          ),
        "",
      )
      if (detail.status !== 200 || detail.partial) {
        return yield* xeroMalformedResponseError(
          "Incomplete Xero contact address response",
        )
      }
      const decoded = yield* decodeJson(
        XeroContactDetailsResponse,
        detail.bodyText,
        "Malformed Xero contact address response",
      )
      const contact = decoded.Contacts[0]
      if (decoded.Contacts.length !== 1 || contact?.ContactID !== contactId) {
        return yield* xeroMalformedResponseError(
          "Unexpected Xero contact in address response",
        )
      }
      defaultBilling = !contact.Addresses.some(
        ({ AddressType, ...content }) =>
          AddressType === "POBOX" &&
          Object.values(content).some(
            (value) => (value?.trim().length ?? 0) > 0,
          ),
      )
    }
    const payload = xeroContactWritePayload(
      input,
      name,
      contactId,
      defaultBilling,
    )
    // Once read-back confirms billing was filled, retries omit it. Keep that
    // STREET-only update distinct from the original fallback payload.
    const writeKey =
      contactId !== undefined && defaultBilling
        ? `${idempotencyKey}:billing-default`
        : idempotencyKey
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "POST",
          "/Contacts",
          current.accessToken,
          current.tenantId,
          writeKey,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(payload)),
      input.lines.map((line) => line.productSku).join(", "),
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
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber,
    type: invoice.Type ?? "",
    status: invoice.Status,
    currency: invoice.CurrencyCode ?? "",
    date: invoice.Date ?? "",
    dueDate: invoice.DueDate ?? "",
    contactId: invoice.Contact?.ContactID ?? "",
    lines: (invoice.LineItems ?? []).map((line) => ({
      itemCode: line.ItemCode ?? "",
      description: line.Description ?? "",
      quantity: Number(line.Quantity),
      unitAmount: wireAmountToMoney(line.UnitAmount) ?? "",
    })),
    total: wireAmountToMoney(invoice.Total) ?? "",
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
          HttpClientRequest.bodyJsonUnsafe(payload),
        ),
      input.lines.map((line) => line.productSku).join(", "),
      true,
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
      toReconcilableInvoice(invoice).lines,
    )
    yield* Effect.log("Issued Xero Sales Invoice").pipe(
      Effect.annotateLogs({
        reference: input.reference,
        invoiceId: issued.invoiceId,
        invoiceNumber: issued.invoiceNumber,
        customerName: input.customer.name,
        customerEmail: input.customer.email,
        productSkus: input.lines.map((line) => line.productSku),
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

const ensureInvoiceNote = (
  httpClient: HttpClient.HttpClient,
  access: XeroAccessCache,
  invoiceId: string,
  note: string,
): Effect.Effect<void, XeroInvoiceError> =>
  Effect.gen(function* () {
    const path = `/Invoices/${invoiceId}/History`
    const history = Schema.Struct({
      HistoryRecords: Schema.Array(
        Schema.Struct({
          Details: Schema.String,
          ValidationErrors: Schema.optional(
            Schema.Array(Schema.Struct({ Message: Schema.String })),
          ),
        }),
      ),
    })
    const result = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest("GET", path, current.accessToken, current.tenantId),
      "",
    )
    const existing = yield* decodeJson(
      history,
      result.bodyText,
      "Malformed Xero invoice history response",
    )
    if (existing.HistoryRecords.some((record) => record.Details === note))
      return
    const written = yield* sendAccounting(
      httpClient,
      access,
      (current) =>
        accountingRequest(
          "PUT",
          path,
          current.accessToken,
          current.tenantId,
          `pf-invoice-note:${createHash("sha256")
            .update(JSON.stringify([current.tenantId, invoiceId, note]))
            .digest("hex")}`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            HistoryRecords: [{ Details: note }],
          }),
        ),
      "",
    )
    const decoded = yield* decodeJson(
      history,
      written.bodyText,
      "Malformed Xero invoice history response",
    )
    const validationErrors = decoded.HistoryRecords.flatMap(
      (record) => record.ValidationErrors ?? [],
    )
    if (validationErrors.length > 0) {
      return yield* xeroValidationError(
        validationErrors.map((error) => error.Message).join("; "),
      )
    }
    if (!decoded.HistoryRecords.some((record) => record.Details === note)) {
      return yield* xeroMalformedResponseError(
        "Xero did not confirm the invoice history note",
      )
    }
  })

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
        const { todoId, externalWriteAttemptId } = yield* CurrentStepJobContext
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
            update: (contact, invoiceInput, idempotencyKey, name) =>
              writeContact(
                httpClient,
                access,
                invoiceInput,
                name,
                contact.contactId,
                idempotencyKey,
              ),
          },
          input,
          todoId,
        )
        const references = [
          ...new Set([
            input.reference,
            ...(input.legacyReference ? [input.legacyReference] : []),
          ]),
        ]
        const existing = (yield* Effect.forEach(references, (reference) =>
          findInvoicesByReference(httpClient, access, reference),
        )).flat()
        const reconciled = yield* reconcileExistingInvoices(
          existing,
          input,
          contactId,
        )
        if (reconciled === undefined && input.recoveryOnly) {
          return yield* xeroValidationError(
            "No existing invoice found; a customer-facing reference is required before creation",
          )
        }
        const issued =
          reconciled ??
          (yield* createInvoice(
            httpClient,
            access,
            contactId,
            input,
            xeroIdempotencyKey(
              externalWriteAttemptId ?? todoId,
              "invoice.create",
            ),
          ))
        if (input.internalNote !== undefined) {
          yield* ensureInvoiceNote(
            httpClient,
            access,
            issued.invoiceId,
            input.internalNote,
          )
        }
        return issued
      }).pipe(Effect.tapError((error) => logInvoiceFailure(input, error)))
    })

    return { issueAuthorisedSalesInvoice }
  }),
)

const CancellationInvoiceWire = Schema.Struct({
  InvoiceID: XeroInvoiceId,
  InvoiceNumber: XeroInvoiceNumber,
  Type: Schema.Literal("ACCREC"),
  Status: Schema.String,
  HasErrors: Schema.optional(Schema.Boolean),
  ValidationErrors: Schema.optional(
    Schema.Array(Schema.Struct({ Message: Schema.String })),
  ),
})

export const XeroInvoiceCancellationLive = Layer.effect(
  XeroInvoiceCancellation,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
    const access = yield* makeXeroAccessCache(
      fetchXeroAccess(httpClient, config),
    )

    const cancel = (
      input: CancelSalesInvoiceInput,
    ): Effect.Effect<CancelledSalesInvoice, XeroInvoiceError> =>
      Effect.gen(function* () {
        const { invoiceId } = yield* decodeCancelSalesInvoiceInput(input)
        const path = `/Invoices/${invoiceId}`
        const readResponse = (response: XeroHttpResult) =>
          Effect.gen(function* () {
            if (response.status !== 200 || response.partial)
              return yield* xeroMalformedResponseError(
                "Incomplete Xero cancellation response",
              )
            const decoded = yield* decodeJson(
              Schema.Struct({
                Invoices: Schema.Array(CancellationInvoiceWire),
              }),
              response.bodyText,
              "Malformed Xero cancellation response",
            )
            const invoice = decoded.Invoices[0]
            if (
              decoded.Invoices.length !== 1 ||
              !invoice ||
              invoice.InvoiceID !== invoiceId
            )
              return yield* xeroMalformedResponseError(
                "Xero cancellation returned an unexpected invoice",
              )
            if (
              invoice.HasErrors ||
              (invoice.ValidationErrors?.length ?? 0) > 0
            )
              return yield* xeroValidationError(
                "Xero rejected invoice cancellation",
              )
            return invoice
          })
        const existing = yield* sendAccounting(
          httpClient,
          access,
          (current) =>
            accountingRequest(
              "GET",
              path,
              current.accessToken,
              current.tenantId,
            ),
          "",
        ).pipe(Effect.flatMap(readResponse))
        // Reconcile provider state even after the idempotency window expires.
        if (existing.Status !== "VOIDED" && existing.Status !== "AUTHORISED")
          return yield* xeroValidationError(
            "Only an authorised Sales Invoice can be cancelled",
          )
        const cancelled =
          existing.Status === "VOIDED"
            ? existing
            : yield* sendAccounting(
                httpClient,
                access,
                (current) =>
                  accountingRequest(
                    "POST",
                    path,
                    current.accessToken,
                    current.tenantId,
                    `pf-invoice-void:${createHash("sha256")
                      .update(JSON.stringify([current.tenantId, invoiceId]))
                      .digest("hex")}`,
                  ).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      Invoices: [{ InvoiceID: invoiceId, Status: "VOIDED" }],
                    }),
                  ),
                "",
              ).pipe(Effect.flatMap(readResponse))
        if (
          cancelled.Status !== "VOIDED" ||
          cancelled.InvoiceNumber !== existing.InvoiceNumber
        )
          return yield* xeroMalformedResponseError(
            "Xero did not confirm cancellation of the original invoice",
          )
        return {
          invoiceId: cancelled.InvoiceID,
          invoiceNumber: cancelled.InvoiceNumber,
          status: "VOIDED",
        }
      })
    return { cancel }
  }),
)

// Xero represents absent optional properties as either missing or null.
const optionalNullable = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optional(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(
        Option.filter((value) => value !== null),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  )

const DirectoryContact = Schema.Struct({
  ContactID: XeroContactId,
  Name: Schema.String,
  ContactStatus: Schema.Literals(["ACTIVE", "ARCHIVED", "GDPRREQUEST"]),
  EmailAddress: optionalNullable(Schema.String),
  ContactPersons: optionalNullable(
    Schema.Array(
      Schema.Struct({
        EmailAddress: optionalNullable(Schema.String),
        IncludeInEmails: optionalNullable(Schema.Boolean),
      }),
    ),
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

const invoiceContact = (
  contact: typeof DirectoryContact.Type,
): InvoiceDirectory["contacts"][number] => ({
  contactId: contact.ContactID,
  name: contact.Name,
  active: contact.ContactStatus === "ACTIVE",
  emails: [
    ...new Set(
      [
        contact.EmailAddress,
        ...(contact.ContactPersons ?? []).map((person) => person.EmailAddress),
      ].flatMap((email) =>
        email ? email.split(/[;,]/).map(normalizeEmail).filter(Boolean) : [],
      ),
    ),
  ],
  invoiceRecipientEmails: enabledInvoiceEmails(contact),
})

const makeDirectoryReader = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
  const access = yield* makeXeroAccessCache(fetchXeroAccess(httpClient, config))

  const readPages = <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
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

  return { readPages, httpClient, access }
})

/** Read-only companion: shares authentication/error handling, never writes. */
export const XeroInvoiceLookupLive = Layer.effect(
  XeroInvoiceLookup,
  Effect.gen(function* () {
    const { readPages } = yield* makeDirectoryReader
    const readDirectory = (
      reference: string,
      previousReference?: string,
    ): Effect.Effect<InvoiceDirectory, XeroInvoiceError> =>
      Effect.gen(function* () {
        const text = yield* Schema.decodeUnknownEffect(
          Schema.Trim.pipe(Schema.check(Schema.isMinLength(1))),
        )(reference).pipe(
          Effect.mapError(() =>
            xeroValidationError("An invoice reference is required"),
          ),
        )
        const references = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))),
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
            page.Contacts.map(invoiceContact),
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

const SalesItemWire = Schema.Struct({
  Code: Schema.String,
  Description: optionalNullable(Schema.String),
  IsSold: optionalNullable(Schema.Boolean),
  SalesDetails: optionalNullable(
    Schema.Struct({ UnitPrice: Schema.optional(Schema.Unknown) }),
  ),
})

export const XeroInvoicePreparationLive = Layer.effect(
  XeroInvoicePreparation,
  Effect.gen(function* () {
    const { readPages, httpClient, access } = yield* makeDirectoryReader
    return {
      read: (codes: readonly string[]) =>
        Effect.gen(function* () {
          const contactPages = yield* readPages(
            "/Contacts?includeArchived=true",
            Schema.Struct({ Contacts: Schema.Array(DirectoryContact) }),
            (page) =>
              page.Contacts.map((contact) => ({ id: contact.ContactID })),
          )
          const items = yield* Effect.forEach([...new Set(codes)], (code) =>
            Effect.gen(function* () {
              const result = yield* sendAccounting(
                httpClient,
                access,
                (current) =>
                  accountingRequest(
                    "GET",
                    `/Items?unitdp=4&where=${encodeURIComponent(`Code=="${code.replaceAll('"', '\\"')}"`)}`,
                    current.accessToken,
                    current.tenantId,
                  ),
                "",
              )
              if (result.status !== 200 || result.partial)
                return yield* xeroMalformedResponseError(
                  `Incomplete Xero item response for ${code}`,
                )
              const decoded = yield* decodeJson(
                Schema.Struct({ Items: Schema.Array(SalesItemWire) }),
                result.bodyText,
                `Malformed Xero item response for ${code}`,
              )
              const matches = decoded.Items.filter((item) => item.Code === code)
              const item = matches.length === 1 ? matches[0] : undefined
              const price = item?.SalesDetails?.UnitPrice
              const invalid = (problem: string): SalesItemResult => ({
                kind: "invalid",
                code,
                problem: `${code}: ${problem}`,
              })
              if (!item)
                return invalid(
                  "item missing or ambiguous in Xero; configure an existing item code",
                )
              if (item.IsSold !== true)
                return invalid("item is not available for sales in Xero")
              if (
                typeof price !== "number" ||
                !Number.isFinite(price) ||
                price < 0 ||
                !Number.isSafeInteger(Math.round(price * 100))
              )
                return invalid(
                  "set a valid non-negative sales price in Xero (zero is allowed)",
                )
              if (!item.Description?.trim())
                return invalid("set a sales description in Xero")
              return {
                kind: "available",
                code,
                description: item.Description,
                unitAmountCents: BigDecimal.toNumberUnsafe(
                  BigDecimal.multiply(
                    BigDecimal.fromNumberUnsafe(price),
                    BigDecimal.make(100n, 0),
                  ),
                ),
              } satisfies SalesItemResult
            }),
          )
          return {
            contacts: contactPages.flatMap((page) =>
              page.Contacts.map(invoiceContact),
            ),
            items,
          }
        }),
    }
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
const CreatedRepeatedDraftWire = Schema.Struct({
  ...CreatedDraftWire.fields,
  LineItems: Schema.Array(
    Schema.Struct({
      Description: Schema.String,
      ItemCode: Schema.optional(Schema.String),
      Quantity: Schema.optional(Schema.Number),
      UnitAmount: Schema.optional(Schema.Number),
      LineAmount: Schema.optional(Schema.Number),
      TaxAmount: Schema.optional(Schema.Number),
      TaxType: Schema.optional(Schema.String),
      AccountCode: Schema.optional(Schema.String),
      Tracking: Schema.optional(
        Schema.Array(
          Schema.Struct({ Name: Schema.String, Option: Schema.String }),
        ),
      ),
    }),
  ),
})
const ContactInvoiceWire = Schema.Struct({
  ...DirectoryInvoice.fields,
  Reference: optionalNullable(Schema.String),
})

export const XeroDraftInvoiceLive = Layer.effectContext(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* requireXeroInvoiceConfig(yield* XeroInvoiceConfig)
    const access = yield* makeXeroAccessCache(
      fetchXeroAccess(httpClient, config),
    )
    const serial = yield* Semaphore.make(1)
    // Pace the lookup/write pair below the tenant's minute budget. Xero's
    // Retry-After handling still applies when other clients share the tenant.
    const request = (
      build: (current: XeroAccess) => HttpClientRequest.HttpClientRequest,
    ) =>
      Effect.sleep("2 seconds").pipe(
        Effect.andThen(
          sendAccounting(httpClient, access, build, "").pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  xeroTimeoutError(
                    "Xero draft request timed out; reconcile before retry",
                  ),
                ),
            }),
          ),
        ),
      )

    const create = (
      input: DraftSalesInvoice | RepeatedDraftSalesInvoice,
      writeKey?: string,
    ): Effect.Effect<DraftInvoiceResult, XeroInvoiceError> => {
      // The repeated operation constructs this effect once per invocation.
      let writeAttempted = false
      return serial.withPermits(1)(
        Effect.gen(function* () {
          const validated: Effect.Effect<
            DraftSalesInvoice | RepeatedDraftSalesInvoice,
            Schema.SchemaError
          > = writeKey
            ? Schema.decodeUnknownEffect(RepeatedDraftSalesInvoice)(input)
            : Schema.decodeUnknownEffect(DraftSalesInvoice)(input)
          const invoice = yield* validated.pipe(
            Effect.mapError(() =>
              xeroValidationError(
                "Invalid draft invoice input or inconsistent amounts",
              ),
            ),
          )
          const duplicateReference =
            ("duplicateReference" in invoice
              ? invoice.duplicateReference
              : undefined) ?? invoice.reference
          if (!writeKey) {
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
              } satisfies DraftInvoiceResult
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
          const key =
            writeKey ??
            xeroDraftIdempotencyKey(
              currentAccess.tenantId,
              invoice.contactId,
              duplicateReference,
            )
          writeAttempted = true
          const response = yield* request((current) =>
            accountingRequest(
              "POST",
              "/Invoices",
              current.accessToken,
              current.tenantId,
              key,
            ).pipe(
              HttpClientRequest.appendUrlParam("SummarizeErrors", "true"),
              (request) =>
                writeKey
                  ? HttpClientRequest.appendUrlParam(request, "unitdp", "4")
                  : request,
              HttpClientRequest.bodyJsonUnsafe({
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
                    LineItems: invoice.lines.map((line) =>
                      "itemCode" in line
                        ? {
                            ItemCode: line.itemCode,
                            Description: line.description,
                            Quantity: line.quantity,
                            UnitAmount: line.unitAmountCents / 100,
                            LineAmount: line.lineAmountCents / 100,
                            TaxAmount: line.taxCents / 100,
                            TaxType: line.taxType,
                            ...("accountCode" in line && {
                              AccountCode: line.accountCode,
                            }),
                            ...("tracking" in line &&
                              line.tracking && {
                                Tracking: line.tracking.map((tracking) => ({
                                  Name: tracking.category,
                                  Option: tracking.option,
                                })),
                              }),
                          }
                        : { Description: line.description },
                    ),
                  },
                ],
              }),
            ),
          ).pipe(
            Effect.retry({
              times: writeKey ? 2 : 0,
              while: (error) => error.retryable,
            }),
          )
          const decoded = yield* decodeJson(
            Schema.Struct({
              Invoices: Schema.Array(
                writeKey ? CreatedRepeatedDraftWire : CreatedDraftWire,
              ),
            }),
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
              if (!expected) return true
              if (!("itemCode" in expected))
                return (
                  line.Description !== expected.description ||
                  ("ItemCode" in line &&
                    line.ItemCode !== undefined &&
                    line.ItemCode !== "") ||
                  ("Quantity" in line &&
                    line.Quantity !== undefined &&
                    line.Quantity !== 0) ||
                  ("UnitAmount" in line &&
                    line.UnitAmount !== undefined &&
                    line.UnitAmount !== 0) ||
                  ("LineAmount" in line &&
                    line.LineAmount !== undefined &&
                    line.LineAmount !== 0) ||
                  ("TaxAmount" in line &&
                    line.TaxAmount !== undefined &&
                    line.TaxAmount !== 0) ||
                  (line.Tracking ?? []).length !== 0
                )
              const tracking =
                "tracking" in expected ? (expected.tracking ?? []) : []
              return (
                line.ItemCode !== expected.itemCode ||
                line.Description !== expected.description ||
                line.Quantity !== expected.quantity ||
                line.UnitAmount !== expected.unitAmountCents / 100 ||
                line.LineAmount !== expected.lineAmountCents / 100 ||
                line.TaxAmount !== expected.taxCents / 100 ||
                line.TaxType !== expected.taxType ||
                (writeKey &&
                  "accountCode" in expected &&
                  (!("AccountCode" in line) ||
                    line.AccountCode !== expected.accountCode)) ||
                (line.Tracking ?? []).length !== tracking.length ||
                tracking.some(
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
          } satisfies DraftInvoiceResult
        }).pipe(
          Effect.mapError((error) =>
            writeKey
              ? new XeroInvoiceError({
                  ...error,
                  message: error.message,
                  draftCreationOutcome: writeAttempted
                    ? "unconfirmed"
                    : "not-created",
                })
              : error,
          ),
        ),
      )
    }
    return Context.make(XeroDraftInvoice, {
      createIfAbsent: (invoice) => create(invoice),
    }).pipe(
      Context.add(XeroRepeatedDraftInvoice, {
        create: (invoice) =>
          Effect.suspend(() =>
            create(invoice, `pf-repeat-draft:${randomUUID()}`),
          ).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(CreatedRepeatedDraft)(result),
            ),
            Effect.mapError((error) =>
              error instanceof Schema.SchemaError
                ? xeroMalformedResponseError("Unexpected repeated draft result")
                : error,
            ),
          ),
      }),
    )
  }),
)
