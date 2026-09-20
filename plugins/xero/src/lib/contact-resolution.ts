import { Effect } from "effect"
import type { XeroInvoiceError } from "./errors"
import { xeroIdempotencyKey } from "./idempotency"
import {
  type CustomerName,
  type InvoiceReference,
  type IssueAuthorisedSalesInvoiceInput,
  isUniqueEmailMatch,
  normalizeEmail,
} from "./identities"

/**
 * Xero contact identity after provider responses have been validated.
 */
export interface ResolvedXeroContact {
  readonly contactId: string
  readonly name?: string
  readonly email?: string
}

/**
 * Contact persistence used by Sales Invoice contact resolution.
 *
 * One normalized email may correspond to multiple Xero contacts. Callers
 * must not pick an arbitrary email match.
 */
export interface XeroContactOperations {
  readonly findByName: (
    name: string,
  ) => Effect.Effect<readonly ResolvedXeroContact[], XeroInvoiceError>
  readonly findByEmail: (
    email: string,
  ) => Effect.Effect<readonly ResolvedXeroContact[], XeroInvoiceError>
  readonly create: (
    input: IssueAuthorisedSalesInvoiceInput,
    name: string,
    idempotencyKey: string,
  ) => Effect.Effect<ResolvedXeroContact, XeroInvoiceError>
  readonly update: (
    contact: ResolvedXeroContact,
    input: IssueAuthorisedSalesInvoiceInput,
    idempotencyKey: string,
  ) => Effect.Effect<ResolvedXeroContact, XeroInvoiceError>
}

export const conflictContactName = ({
  customerName,
  orderNumber,
}: {
  readonly customerName: CustomerName
  readonly orderNumber: InvoiceReference
}): string => `${customerName} ${orderNumber}`

export const isContactNameConflict = (message: string): boolean => {
  const lower = message.toLowerCase()
  const mentionsName =
    lower.includes("contact name") || lower.includes("contactname")
  const mentionsUniqueness =
    lower.includes("unique") || lower.includes("already")
  return mentionsName && mentionsUniqueness
}

export const XERO_CONTACT_NAME_MUST_BE_UNIQUE =
  "The contact name must be unique."

const onlyItem = <T>(items: readonly T[]): T | undefined =>
  items.length === 1 ? items[0] : undefined

const hasMatchingEmail = (
  contact: ResolvedXeroContact,
  email: string,
): boolean =>
  contact.email !== undefined &&
  normalizeEmail(contact.email) === normalizeEmail(email)

const recoverOriginalNameOrCreateSuffix = (
  contacts: XeroContactOperations,
  input: IssueAuthorisedSalesInvoiceInput,
  todoId: string,
  conflictName: string,
): Effect.Effect<ResolvedXeroContact, XeroInvoiceError> =>
  Effect.gen(function* () {
    const originalNamed = yield* contacts.findByName(input.customer.name)
    const recoveredOriginal = onlyItem(
      originalNamed.filter((contact) =>
        hasMatchingEmail(contact, input.customer.email),
      ),
    )
    if (recoveredOriginal !== undefined) {
      return yield* contacts.update(
        recoveredOriginal,
        input,
        xeroIdempotencyKey(todoId, "contact.update"),
      )
    }
    return yield* contacts.create(
      input,
      conflictName,
      xeroIdempotencyKey(todoId, "contact.create.conflict"),
    )
  })

/**
 * Resolve the Xero contact for a Sales Invoice.
 *
 * Looks up a prior suffixed contact first, then applies email matching:
 * exactly one normalized email match is updated, while zero or multiple
 * matches create a contact. A unique-name conflict first recovers a prior
 * create under the original name with the same email, then retries with the
 * Order Number suffix.
 */
export const resolveInvoiceContact = (
  contacts: XeroContactOperations,
  input: IssueAuthorisedSalesInvoiceInput,
  todoId: string,
): Effect.Effect<string, XeroInvoiceError> =>
  Effect.gen(function* () {
    const conflictName = conflictContactName({
      customerName: input.customer.name,
      orderNumber: input.reference,
    })
    const named = yield* contacts.findByName(conflictName)
    const priorSuffixed = onlyItem(named)
    if (priorSuffixed !== undefined) {
      return priorSuffixed.contactId
    }

    const emailMatches = yield* contacts.findByEmail(input.customer.email)
    const uniqueMatch = isUniqueEmailMatch(emailMatches.length)
      ? emailMatches[0]
      : undefined
    if (uniqueMatch !== undefined) {
      const updated = yield* contacts.update(
        uniqueMatch,
        input,
        xeroIdempotencyKey(todoId, "contact.update"),
      )
      return updated.contactId
    }

    if (emailMatches.length > 1) {
      yield* Effect.log(
        "Creating another Xero contact because one normalized email matched multiple Xero contacts",
      ).pipe(
        Effect.annotateLogs({
          reference: input.reference,
          customerName: input.customer.name,
          customerEmail: input.customer.email,
        }),
      )
    }

    const created = yield* contacts
      .create(
        input,
        input.customer.name,
        xeroIdempotencyKey(todoId, "contact.create"),
      )
      .pipe(
        Effect.catchAll((error) =>
          isContactNameConflict(error.message)
            ? recoverOriginalNameOrCreateSuffix(
                contacts,
                input,
                todoId,
                conflictName,
              )
            : Effect.fail(error),
        ),
      )
    return created.contactId
  })
