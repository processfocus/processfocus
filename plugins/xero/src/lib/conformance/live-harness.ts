import { Headers, HttpClient, HttpClientRequest } from "@effect/platform"
import {
  Clock,
  type Context,
  Effect,
  Either,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { CurrentStepJobContext } from "@pf/process"
import {
  type XeroInvoiceError,
  xeroAuthError,
  xeroMalformedResponseError,
  xeroPermissionError,
  xeroProviderServerError,
  xeroRateLimitError,
} from "../errors"
import {
  parseXeroCalendarDate,
  wireAmountToMoney,
} from "../invoice-reconciliation"
import { mapHttpClientError, parseRetryAfterSeconds } from "../xero-http"
import { XeroInvoice } from "../xero-invoice"
import { XeroInvoiceConfig, XeroInvoiceLive } from "../xero-invoice-live"
import {
  type XeroAccess,
  makeXeroAccessCache,
  refreshAfterMsFromExpiresIn,
} from "../xero-token"
import { XeroConnectionsResponse, XeroTokenResponse } from "../xero-wire"
import type {
  ConformanceHarness,
  ObservableInvoice,
  ScenarioObservation,
} from "./scenarios"

const TOKEN_URL = "https://identity.xero.com/connect/token"
const CONNECTIONS_URL = "https://api.xero.com/connections"
const ACCOUNTING_URL = "https://api.xero.com/api.xro/2.0"

const Amount = Schema.Union(Schema.Number, Schema.String)

const ObservationInvoice = Schema.Struct({
  InvoiceID: Schema.String,
  InvoiceNumber: Schema.String,
  Status: Schema.String,
  Type: Schema.optional(Schema.String),
  Reference: Schema.optional(Schema.String),
  Date: Schema.optional(Schema.String),
  DueDate: Schema.optional(Schema.String),
  CurrencyCode: Schema.optional(Schema.String),
  Total: Schema.optional(Amount),
  TotalTax: Schema.optional(Amount),
  Contact: Schema.optional(
    Schema.Struct({
      ContactID: Schema.optional(Schema.String),
    }),
  ),
  LineItems: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ItemCode: Schema.optional(Schema.String),
        Quantity: Schema.optional(Amount),
        UnitAmount: Schema.optional(Amount),
      }),
    ),
  ),
})

const ObservationInvoices = Schema.Struct({
  Invoices: Schema.Array(ObservationInvoice),
})

const normalizeQuantity = (value: string | undefined): string => {
  if (value === undefined) {
    return ""
  }
  return value === "1.00" ? "1" : value
}

export const classifyAccountingObservationFailure = (
  status: number,
  retryAfter: string | undefined,
  nowMs: number,
): XeroInvoiceError => {
  if (status === 401) {
    return xeroAuthError("Xero Custom Connection authentication failed")
  }
  if (status === 403) {
    return xeroPermissionError(
      "Xero Custom Connection is missing required permissions",
    )
  }
  if (status === 429) {
    return xeroRateLimitError(parseRetryAfterSeconds(retryAfter, nowMs))
  }
  if (status >= 500) {
    return xeroProviderServerError(status)
  }
  return xeroMalformedResponseError("Malformed Xero invoice response")
}

const execute = (
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  {
    readonly status: number
    readonly bodyText: string
    readonly retryAfter: string | undefined
  },
  XeroInvoiceError
> =>
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
      retryAfter: Option.getOrUndefined(
        Headers.get(response.headers, "retry-after"),
      ),
    }
  })

const decodeJson = <A, I>(
  schema: Schema.Schema<A, I>,
  bodyText: string,
  message: string,
): Effect.Effect<A, XeroInvoiceError> =>
  Schema.decodeUnknown(Schema.parseJson(schema))(bodyText).pipe(
    Effect.mapError(() => xeroMalformedResponseError(message)),
  )

const fetchAccess = (
  httpClient: HttpClient.HttpClient,
  config: Context.Tag.Service<typeof XeroInvoiceConfig>,
): Effect.Effect<XeroAccess, XeroInvoiceError> =>
  Effect.gen(function* () {
    const tokenResult = yield* execute(
      httpClient,
      HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.basicAuth(config.clientId, config.clientSecret),
        HttpClientRequest.bodyUrlParams({
          grant_type: "client_credentials",
          scope: config.scopes,
        }),
      ),
    )
    if (tokenResult.status < 200 || tokenResult.status >= 300) {
      return yield* xeroAuthError(
        "Xero Custom Connection authentication failed",
      )
    }
    const token = yield* decodeJson(
      XeroTokenResponse,
      tokenResult.bodyText,
      "Malformed Xero token response",
    )
    const accessToken = Redacted.make(token.access_token)
    const connectionsResult = yield* execute(
      httpClient,
      HttpClientRequest.get(CONNECTIONS_URL).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeader("Accept", "application/json"),
      ),
    )
    if (connectionsResult.status < 200 || connectionsResult.status >= 300) {
      return yield* xeroAuthError(
        "Xero Custom Connection authentication failed",
      )
    }
    const connections = yield* decodeJson(
      XeroConnectionsResponse,
      connectionsResult.bodyText,
      "Malformed Xero connections response",
    )
    if (connections.length !== 1 || connections[0] === undefined) {
      return yield* xeroAuthError(
        "Xero Custom Connection must be linked to exactly one organisation",
      )
    }
    const nowMs = yield* Clock.currentTimeMillis
    return {
      accessToken,
      tenantId: connections[0].tenantId,
      refreshAfterMs: refreshAfterMsFromExpiresIn(nowMs, token.expires_in),
    }
  })

const accountingGet = (
  access: XeroAccess,
  path: string,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(`${ACCOUNTING_URL}${path}`).pipe(
    HttpClientRequest.bearerToken(access.accessToken),
    HttpClientRequest.setHeader("Xero-tenant-id", access.tenantId),
    HttpClientRequest.setHeader("Accept", "application/json"),
  )

const toObservable = (
  invoice: typeof ObservationInvoice.Type,
): ObservableInvoice => {
  const line = invoice.LineItems?.[0]
  return {
    type: invoice.Type ?? "",
    status: invoice.Status,
    currency: invoice.CurrencyCode ?? "",
    reference: invoice.Reference ?? "",
    total: wireAmountToMoney(invoice.Total) ?? "",
    totalTax: wireAmountToMoney(invoice.TotalTax) ?? "",
    itemCode: line?.ItemCode ?? "",
    quantity: normalizeQuantity(wireAmountToMoney(line?.Quantity)),
    unitAmount: wireAmountToMoney(line?.UnitAmount) ?? "",
    lineCount: invoice.LineItems?.length ?? 0,
    contactId: invoice.Contact?.ContactID ?? "",
    date: parseXeroCalendarDate(invoice.Date ?? "") ?? "",
    dueDate: parseXeroCalendarDate(invoice.DueDate ?? "") ?? "",
  }
}

const xeroWhereEquals = (field: string, value: string): string =>
  `${field}=="${value.replaceAll('"', '""')}"`

export const makeLiveConformanceHarness = (
  requestedUrls: string[],
): Effect.Effect<
  ConformanceHarness,
  XeroInvoiceError,
  HttpClient.HttpClient | XeroInvoiceConfig
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const config = yield* XeroInvoiceConfig
    const accessCache = yield* makeXeroAccessCache(
      fetchAccess(httpClient, config),
    )
    const liveLayer = Layer.provide(
      XeroInvoiceLive,
      Layer.merge(
        Layer.succeed(XeroInvoiceConfig, config),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      ),
    )

    const readInvoices = (path: string) =>
      Effect.gen(function* () {
        const firstAccess = yield* accessCache.get()
        const first = yield* execute(
          httpClient,
          accountingGet(firstAccess, path),
        )
        const result =
          first.status === 401
            ? yield* Effect.gen(function* () {
                yield* accessCache.invalidate()
                const secondAccess = yield* accessCache.get()
                return yield* execute(
                  httpClient,
                  accountingGet(secondAccess, path),
                )
              })
            : first
        if (result.status < 200 || result.status >= 300) {
          const nowMs = yield* Clock.currentTimeMillis
          return yield* classifyAccountingObservationFailure(
            result.status,
            result.retryAfter,
            nowMs,
          )
        }
        return yield* decodeJson(
          ObservationInvoices,
          result.bodyText,
          "Malformed Xero invoice response",
        )
      })

    return {
      kind: "live" as const,
      prepare: () => Effect.void,
      issue: (input, todoId) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            const xero = yield* XeroInvoice
            return yield* xero.issueAuthorisedSalesInvoice(input)
          }).pipe(
            Effect.provide(liveLayer),
            Effect.provideService(CurrentStepJobContext, {
              todoId,
              stepPath: "/Create Xero Invoice",
            }),
            Effect.either,
          )
          return yield* Either.match(result, {
            onLeft: (error) =>
              Effect.succeed({
                kind: "failed" as const,
                failed: {
                  code: error.code ?? "unknown",
                  retryable: error.retryable,
                  fields: error.fields ?? [],
                  message: error.message,
                },
              } satisfies ScenarioObservation),
            onRight: (issued) =>
              Effect.gen(function* () {
                const decoded = yield* readInvoices(
                  `/Invoices/${issued.invoiceId}`,
                )
                const invoice = decoded.Invoices[0]
                if (decoded.Invoices.length !== 1 || invoice === undefined) {
                  return {
                    kind: "failed" as const,
                    failed: {
                      code: "malformed_response",
                      retryable: false,
                      fields: [],
                      message: "Malformed Xero invoice response",
                    },
                  } satisfies ScenarioObservation
                }
                return {
                  kind: "issued" as const,
                  issued: {
                    invoiceId: `${issued.invoiceId}`,
                    invoiceNumber: `${issued.invoiceNumber}`,
                    invoice: toObservable(invoice),
                  },
                } satisfies ScenarioObservation
              }),
          })
        }),
      invoiceCountByReference: (reference) =>
        Effect.gen(function* () {
          const decoded = yield* readInvoices(
            `/Invoices?where=${encodeURIComponent(xeroWhereEquals("Reference", reference))}`,
          )
          return decoded.Invoices.filter(
            (invoice) => invoice.Reference === reference,
          ).length
        }),
      requestedUrls: () => [...requestedUrls],
    }
  })
