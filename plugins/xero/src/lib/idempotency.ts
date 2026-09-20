/**
 * Xero retains idempotency results for six minutes from the first call.
 * After expiry, the same key is treated as a new write.
 */
export const XERO_IDEMPOTENCY_RETENTION_MS = 6 * 60 * 1000

export type XeroIdempotencyOperation =
  | "contact.create"
  | "contact.create.conflict"
  | "contact.update"
  | "invoice.create"

export const xeroIdempotencyKey = (
  todoId: string,
  operation: XeroIdempotencyOperation,
): string => `${todoId}:${operation}`

/** Stable across executions as well as retries for one contact/reference intent. */
export const xeroDraftIdempotencyKey = (
  tenantId: string,
  contactId: string,
  reference: string,
): string =>
  `pf-draft:${createHash("sha256")
    .update(
      JSON.stringify([
        tenantId.toLowerCase(),
        contactId.toLowerCase(),
        reference.trim().replace(/\s+/g, " ").toUpperCase(),
      ]),
    )
    .digest("hex")}`

export const xeroIdempotencyFingerprint = ({
  method,
  target,
  body,
}: {
  readonly method: string
  readonly target: string
  readonly body: unknown
}): string => `${method}:${target}:${JSON.stringify(body)}`

export const isXeroIdempotencyConflictMessage = (message: string): boolean => {
  const lower = message.toLowerCase()
  return (
    lower.includes("idempotency key") && lower.includes("different request")
  )
}

import { createHash } from "node:crypto"
