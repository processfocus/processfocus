import type { HttpClientError } from "@effect/platform/HttpClientError"
import { Duration, Effect } from "effect"
import {
  type XeroInvoiceError,
  xeroTimeoutError,
  xeroTransportError,
} from "./errors"

const XERO_MIN_RETRY_AFTER_SECONDS = 1
const XERO_MAX_RETRY_AFTER_SECONDS = 60

/**
 * Parse a Xero Retry-After header as a bounded wait in seconds.
 *
 * Missing, zero, or unparseable values wait the minimum so retries cannot
 * tight-loop against Xero. HTTP-date values are converted from `nowMs`.
 */
export const parseRetryAfterSeconds = (
  raw: string | undefined,
  nowMs: number,
): number => {
  if (raw === undefined || raw.trim() === "") {
    return XERO_MIN_RETRY_AFTER_SECONDS
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return clampRetryAfterSeconds(Math.ceil(asNumber))
  }

  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) {
    return clampRetryAfterSeconds(Math.ceil((dateMs - nowMs) / 1000))
  }

  return XERO_MIN_RETRY_AFTER_SECONDS
}

export const waitForRetryAfter = (seconds: number): Effect.Effect<void> =>
  Effect.sleep(Duration.seconds(clampRetryAfterSeconds(seconds)))

export const mapHttpClientError = (
  error: HttpClientError,
): XeroInvoiceError => {
  if (isTimeoutHttpClientError(error)) {
    return xeroTimeoutError("Xero request timed out")
  }
  return xeroTransportError("Xero request failed")
}

const clampRetryAfterSeconds = (seconds: number): number => {
  if (seconds < XERO_MIN_RETRY_AFTER_SECONDS) {
    return XERO_MIN_RETRY_AFTER_SECONDS
  }
  if (seconds > XERO_MAX_RETRY_AFTER_SECONDS) {
    return XERO_MAX_RETRY_AFTER_SECONDS
  }
  return seconds
}

const isTimeoutHttpClientError = (error: HttpClientError): boolean => {
  const haystack = `${error.message} ${error._tag} ${String(error.reason)} ${stringifyCause(error.cause)}`
  const lower = haystack.toLowerCase()
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("aborted") ||
    lower.includes("abort")
  )
}

const stringifyCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name} ${cause.message}`
  }
  return ""
}
