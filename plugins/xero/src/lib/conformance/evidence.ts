import { CONFORMANCE_SHIPPING_LINE1 } from "./catalog"

const PROHIBITED_KEY =
  /address|authorization|bearer|client_secret|password|payload|secret|shipping|token/i

const PROHIBITED_VALUE_FRAGMENTS = [
  CONFORMANCE_SHIPPING_LINE1,
  "Bearer ",
  "client_secret",
  "xero-access-token",
  "xero-client-secret",
] as const

export const containsProhibitedDiagnostics = (value: string): boolean =>
  PROHIBITED_VALUE_FRAGMENTS.some((fragment) => value.includes(fragment)) ||
  /AddressLine\d|Shipping Address/i.test(value)

const redactString = (value: string): string => {
  let next = value
  for (const fragment of PROHIBITED_VALUE_FRAGMENTS) {
    next = next.replaceAll(fragment, "[redacted]")
  }
  return next
}

export const sanitizeEvidence = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactString(value)
  }
  if (typeof value !== "object" || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeEvidence)
  }
  const entries = Object.entries(value).flatMap(([key, nested]) => {
    if (PROHIBITED_KEY.test(key)) {
      return []
    }
    return [[key, sanitizeEvidence(nested)] as const]
  })
  return Object.fromEntries(entries)
}

export const evidenceJson = (value: unknown): string =>
  JSON.stringify(sanitizeEvidence(value))
