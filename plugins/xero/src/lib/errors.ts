import { Data } from "effect"

/**
 * Failure from the Xero invoice operation.
 *
 * `retryable: true` marks failures that may succeed unchanged after a later
 * attempt: network, timeout, rate limit, and provider-server errors.
 * `retryable: false` marks deterministic refusals and deployment or
 * provider-contract faults that must fail immediately.
 */
export class XeroInvoiceError extends Data.TaggedError("XeroInvoiceError")<{
  readonly message: string
  readonly retryable: boolean
  readonly code?: string
  readonly fields?: readonly string[]
  readonly retryAfterSeconds?: number
  readonly cause?: unknown
}> {}

export const xeroValidationError = (
  message: string,
  options?: {
    readonly code?: string
    readonly fields?: readonly string[]
  },
): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: options?.code ?? "validation",
    ...(options?.fields !== undefined && options.fields.length > 0
      ? { fields: options.fields }
      : {}),
  })

export const xeroUnknownItemCodeError = (
  productSku: string,
): XeroInvoiceError =>
  new XeroInvoiceError({
    message: `Unknown Product SKU '${productSku}'`,
    retryable: false,
    code: "unknown_item_code",
    fields: ["ItemCode"],
  })

export const xeroTransportError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: true,
    code: "transport",
  })

export const xeroTimeoutError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: true,
    code: "timeout",
  })

export const xeroRateLimitError = (
  retryAfterSeconds: number,
): XeroInvoiceError =>
  new XeroInvoiceError({
    message: `Xero rate limited; retry after ${String(retryAfterSeconds)} seconds`,
    retryable: true,
    code: "rate_limit",
    retryAfterSeconds,
  })

export const xeroProviderServerError = (status: number): XeroInvoiceError =>
  new XeroInvoiceError({
    message: `Xero request failed (${String(status)})`,
    retryable: true,
    code: "provider_server",
  })

export const xeroAuthError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: "auth",
  })

export const xeroPermissionError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: "permission",
  })

export const xeroMalformedResponseError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: "malformed_response",
  })

export const xeroDeploymentError = (message: string): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: "deployment",
  })

export const xeroUnsupportedOperationError = (
  message: string,
): XeroInvoiceError =>
  new XeroInvoiceError({
    message,
    retryable: false,
    code: "unsupported_operation",
  })

export const xeroIdempotencyConflictError = (): XeroInvoiceError =>
  new XeroInvoiceError({
    message:
      "Xero idempotency key was reused with a different method, target, or body",
    retryable: false,
    code: "idempotency_conflict",
  })

export const xeroAmbiguousReferenceError = (
  reference: string,
): XeroInvoiceError =>
  new XeroInvoiceError({
    message: `Multiple Xero invoices share Order Number Reference '${reference}'`,
    retryable: false,
    code: "ambiguous_reference",
  })

export const xeroInvoiceIntentConflictError = (
  reference: string,
): XeroInvoiceError =>
  new XeroInvoiceError({
    message: `Existing Xero invoice for Order Number Reference '${reference}' does not match this Sales Invoice intent`,
    retryable: false,
    code: "intent_conflict",
  })
