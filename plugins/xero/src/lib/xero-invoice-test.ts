import { Effect, Layer } from "effect"
import { CurrentStepJobContext } from "@pf/process"
import {
  type ResolvedXeroContact,
  XERO_CONTACT_NAME_MUST_BE_UNIQUE,
  resolveInvoiceContact,
} from "./contact-resolution"
import {
  type XeroInvoiceError,
  xeroAuthError,
  xeroDeploymentError,
  xeroIdempotencyConflictError,
  xeroMalformedResponseError,
  xeroPermissionError,
  xeroProviderServerError,
  xeroRateLimitError,
  xeroTimeoutError,
  xeroTransportError,
  xeroUnknownItemCodeError,
  xeroUnsupportedOperationError,
  xeroValidationError,
} from "./errors"
import {
  XERO_IDEMPOTENCY_RETENTION_MS,
  type XeroIdempotencyOperation,
  xeroIdempotencyFingerprint,
  xeroIdempotencyKey,
} from "./idempotency"
import {
  type CalendarDate,
  type CurrencyCode,
  type ExactMoney,
  type IssueAuthorisedSalesInvoiceInput,
  type IssuedSalesInvoice,
  type ProductSku,
  type ShippingAddress,
  normalizeEmail,
} from "./identities"
import {
  type ReconcilableInvoice,
  decodeIssuedSalesInvoice,
  reconcileExistingInvoices,
} from "./invoice-reconciliation"
import { centsToMoney, inclusiveTaxCents, moneyToCents } from "./money"
import { XeroInvoice } from "./xero-invoice"

export type XeroItemTaxType = "NONE" | "OUTPUT"

export interface XeroTestItem {
  readonly itemCode: ProductSku | string
  readonly name: string
  readonly taxType: XeroItemTaxType
  readonly taxPercent: 0 | 15
}

export interface XeroTestAddress {
  readonly addressType: "STREET" | "POBOX" | "DELIVERY"
  readonly line1: string
  readonly line2?: string
  readonly city: string
  readonly region?: string
  readonly postalCode?: string
  readonly country?: string
}

export interface XeroTestContact {
  readonly contactId: string
  readonly name: string
  readonly email: string
  readonly addresses: readonly XeroTestAddress[]
}

export interface XeroTestInvoiceLine {
  readonly itemCode: string
  readonly description: string
  readonly quantity: "1"
  readonly unitAmount: string
}

export type XeroTestInvoiceType = "ACCREC" | "ACCPAY"
export type XeroTestInvoiceStatus =
  | "AUTHORISED"
  | "DRAFT"
  | "SUBMITTED"
  | "VOIDED"

export interface XeroTestInvoice {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly type: XeroTestInvoiceType
  readonly status: XeroTestInvoiceStatus
  readonly currency: CurrencyCode
  readonly reference: string
  readonly date: CalendarDate | string
  readonly dueDate: CalendarDate | string
  readonly lineAmountTypes: "Inclusive"
  readonly contactId: string
  readonly lines: readonly XeroTestInvoiceLine[]
  readonly total: string
  readonly totalTax: string
  readonly subTotal: string
}

/**
 * Seed a Xero contact. Duplicate normalized emails and duplicate names
 * are allowed so tests can model Xero's unique-name rule and the accepted
 * policy that one normalized email may correspond to multiple Xero contacts.
 */
export interface SeedXeroTestContact {
  readonly contactId?: string
  readonly name: string
  readonly email: string
  readonly addresses?: readonly XeroTestAddress[]
}

export interface SeedXeroTestInvoice {
  readonly invoiceId?: string
  readonly invoiceNumber?: string
  readonly contactId: string
  readonly reference: string
  readonly date: string
  readonly dueDate: string
  readonly currency?: CurrencyCode
  readonly type?: XeroTestInvoiceType
  readonly status?: XeroTestInvoiceStatus
  readonly itemCode: string
  readonly unitAmount: ExactMoney | string
  readonly total: string
  readonly totalTax: string
  readonly subTotal: string
}

type XeroTestIdempotencyTarget = "/Contacts" | "/Invoices"

export interface XeroTestIdempotencyRecord {
  readonly key: string
  readonly method: "POST"
  readonly target: XeroTestIdempotencyTarget
  readonly expiresAt: number
}

export interface SeedXeroTestIdempotencyWrite {
  readonly key: string
  readonly method: "POST"
  readonly target: XeroTestIdempotencyTarget
  readonly body: unknown
}

export type XeroTestFailureKind = XeroScriptedFailure["kind"]

type XeroScriptedCommitFailure = {
  readonly afterCommit?: boolean
  readonly operation?: XeroIdempotencyOperation
}

export type XeroScriptedFailure =
  | { readonly kind: "transport"; readonly message?: string }
  | ({
      readonly kind: "timeout"
      readonly message?: string
    } & XeroScriptedCommitFailure)
  | {
      readonly kind: "validation"
      readonly message?: string
      readonly fields?: readonly string[]
    }
  | { readonly kind: "auth"; readonly message?: string }
  | { readonly kind: "permission"; readonly message?: string }
  | {
      readonly kind: "rate_limit"
      readonly message?: string
      readonly retryAfterSeconds?: number
    }
  | { readonly kind: "malformed_response"; readonly message?: string }
  | ({
      readonly kind: "provider_server"
      readonly message?: string
      readonly status?: number
    } & XeroScriptedCommitFailure)
  | { readonly kind: "unsupported_operation"; readonly message?: string }
  | { readonly kind: "deployment"; readonly message?: string }

export interface XeroTestRateBudget {
  readonly remaining: number
  readonly retryAfterSeconds?: number
}

export interface XeroInvoiceTestController {
  readonly seedItem: (item: XeroTestItem) => void
  readonly seedContact: (contact: SeedXeroTestContact) => XeroTestContact
  readonly seedInvoice: (invoice: SeedXeroTestInvoice) => XeroTestInvoice
  readonly seedIdempotencyWrite: (write: SeedXeroTestIdempotencyWrite) => void
  readonly seedRateBudget: (budget: XeroTestRateBudget) => void
  readonly scriptFailure: (failure: XeroScriptedFailure) => void
  readonly scriptTimeoutAfterCommit: (
    operation: XeroIdempotencyOperation,
  ) => void
  readonly now: () => number
  readonly setNow: (epochMilliseconds: number) => void
  readonly advanceTime: (durationMilliseconds: number) => void
  readonly listItems: () => readonly XeroTestItem[]
  readonly listContacts: () => readonly XeroTestContact[]
  readonly listInvoices: () => readonly XeroTestInvoice[]
  readonly listIdempotencyKeys: () => readonly XeroTestIdempotencyRecord[]
  readonly findContactByEmail: (email: string) => readonly XeroTestContact[]
  readonly findContactByName: (name: string) => readonly XeroTestContact[]
  readonly findInvoiceByReference: (
    reference: string,
  ) => readonly XeroTestInvoice[]
  readonly clear: () => void
}

export interface XeroInvoiceTestPlugin {
  readonly layer: Layer.Layer<XeroInvoice, never, never>
  readonly controller: XeroInvoiceTestController
}

const DEFAULT_NOW_MS = Date.UTC(2026, 2, 15, 12, 0, 0)

const padSequence = (value: number): string => String(value).padStart(11, "0")

const nextGuid = (kind: "contact" | "invoice", sequence: number): string => {
  const prefix = kind === "contact" ? "c" : "e"
  return `00000000-0000-4000-8000-${prefix}${padSequence(sequence)}`
}

const cloneAddress = (address: XeroTestAddress): XeroTestAddress => ({
  addressType: address.addressType,
  line1: address.line1,
  ...(address.line2 !== undefined && { line2: address.line2 }),
  city: address.city,
  ...(address.region !== undefined && { region: address.region }),
  ...(address.postalCode !== undefined && {
    postalCode: address.postalCode,
  }),
  ...(address.country !== undefined && { country: address.country }),
})

const cloneContact = (contact: XeroTestContact): XeroTestContact => ({
  contactId: contact.contactId,
  name: contact.name,
  email: contact.email,
  addresses: contact.addresses.map(cloneAddress),
})

const cloneInvoice = (invoice: XeroTestInvoice): XeroTestInvoice => ({
  ...invoice,
  lines: invoice.lines.map((line) => ({ ...line })),
})

const shippingToStreet = (shipping: ShippingAddress): XeroTestAddress => ({
  addressType: "STREET",
  line1: shipping.line1,
  ...(shipping.line2 !== undefined && { line2: shipping.line2 }),
  city: shipping.city,
  ...(shipping.region !== undefined && { region: shipping.region }),
  ...(shipping.postalCode !== undefined && {
    postalCode: shipping.postalCode,
  }),
  ...(shipping.country !== undefined && { country: shipping.country }),
})

const replaceStreetAddress = (
  addresses: readonly XeroTestAddress[],
  street: XeroTestAddress,
): readonly XeroTestAddress[] => [
  ...addresses.filter((address) => address.addressType !== "STREET"),
  street,
]

const toResolved = (contact: XeroTestContact): ResolvedXeroContact => ({
  contactId: contact.contactId,
  name: contact.name,
  email: contact.email,
})

const toReconcilable = (invoice: XeroTestInvoice): ReconcilableInvoice => ({
  invoiceId: invoice.invoiceId,
  invoiceNumber: invoice.invoiceNumber,
  type: invoice.type,
  status: invoice.status,
  currency: invoice.currency,
  date: String(invoice.date),
  dueDate: String(invoice.dueDate),
  contactId: invoice.contactId,
  itemCode: invoice.lines[0]?.itemCode ?? "",
  unitAmount: invoice.lines[0]?.unitAmount ?? "",
  total: invoice.total,
  lineCount: invoice.lines.length,
})

interface StoredIdempotencyRecord {
  readonly key: string
  readonly method: "POST"
  readonly target: XeroTestIdempotencyTarget
  readonly fingerprint: string
  readonly storedAt: number
  readonly contact?: ResolvedXeroContact
  readonly invoice?: IssuedSalesInvoice
}

const IMMEDIATE_FAILURE_KINDS: readonly XeroTestFailureKind[] = [
  "transport",
  "timeout",
  "auth",
  "permission",
  "rate_limit",
  "unsupported_operation",
  "deployment",
]

const CREATE_FAILURE_KINDS: readonly XeroTestFailureKind[] = [
  "validation",
  "malformed_response",
  "provider_server",
]

const toScriptedError = (failure: XeroScriptedFailure): XeroInvoiceError => {
  const message = failure.message
  switch (failure.kind) {
    case "transport":
      return xeroTransportError(message ?? "Xero request failed")
    case "timeout":
      return xeroTimeoutError(message ?? "Xero request timed out")
    case "validation":
      return xeroValidationError(
        message ?? "Xero request was rejected (400)",
        failure.fields !== undefined ? { fields: failure.fields } : undefined,
      )
    case "auth":
      return xeroAuthError(
        message ?? "Xero Custom Connection authentication failed",
      )
    case "permission":
      return xeroPermissionError(
        message ?? "Xero Custom Connection is missing required permissions",
      )
    case "rate_limit":
      return xeroRateLimitError(failure.retryAfterSeconds ?? 1)
    case "malformed_response":
      return xeroMalformedResponseError(
        message ?? "Malformed Xero invoice response",
      )
    case "provider_server":
      return xeroProviderServerError(failure.status ?? 500)
    case "unsupported_operation":
      return xeroUnsupportedOperationError(
        message ?? "Xero operation is not supported",
      )
    case "deployment":
      return xeroDeploymentError(
        message ??
          "Xero Custom Connection configuration is missing or malformed",
      )
  }
}

export const makeXeroInvoiceTestPlugin = (): XeroInvoiceTestPlugin => {
  const items: XeroTestItem[] = []
  const contacts: XeroTestContact[] = []
  const invoices: XeroTestInvoice[] = []
  const idempotencyRecords = new Map<string, StoredIdempotencyRecord>()
  const pendingTimeouts = new Set<XeroIdempotencyOperation>()
  const scriptedFailures: XeroScriptedFailure[] = []
  const pendingCommitFailures = new Map<
    XeroIdempotencyOperation,
    XeroScriptedFailure
  >()
  let nextContactSequence = 1
  let nextInvoiceSequence = 1
  let nowMs = DEFAULT_NOW_MS
  let rateRemaining: number | undefined
  let rateRetryAfterSeconds = 1

  const consumeScriptedFailure = (
    kinds: readonly XeroTestFailureKind[],
  ): Effect.Effect<void, XeroInvoiceError> => {
    const next = scriptedFailures[0]
    if (next === undefined || !kinds.includes(next.kind)) {
      return Effect.void
    }
    scriptedFailures.shift()
    return Effect.fail(toScriptedError(next))
  }

  const consumeRateBudget = (): Effect.Effect<void, XeroInvoiceError> => {
    if (rateRemaining === undefined) {
      return Effect.void
    }
    if (rateRemaining <= 0) {
      return Effect.fail(xeroRateLimitError(rateRetryAfterSeconds))
    }
    rateRemaining -= 1
    return Effect.void
  }

  const allocateContactId = (explicit?: string): string => {
    if (explicit !== undefined) {
      return explicit
    }
    const contactId = nextGuid("contact", nextContactSequence)
    nextContactSequence += 1
    return contactId
  }

  const allocateInvoiceIdentity = (input?: {
    readonly invoiceId?: string
    readonly invoiceNumber?: string
  }): { invoiceId: string; invoiceNumber: string } => {
    const invoiceId =
      input?.invoiceId ?? nextGuid("invoice", nextInvoiceSequence)
    const invoiceNumber =
      input?.invoiceNumber ??
      `INV-${String(nextInvoiceSequence).padStart(4, "0")}`
    nextInvoiceSequence += 1
    return { invoiceId, invoiceNumber }
  }

  const findStoredByName = (name: string): XeroTestContact[] =>
    contacts.filter((contact) => contact.name === name)

  const findStoredByEmail = (email: string): XeroTestContact[] =>
    contacts.filter(
      (contact) => normalizeEmail(contact.email) === normalizeEmail(email),
    )

  const findStoredByReference = (reference: string): XeroTestInvoice[] =>
    invoices.filter((invoice) => invoice.reference === reference)

  const unexpiredIdempotency = (
    key: string,
  ): StoredIdempotencyRecord | undefined => {
    const record = idempotencyRecords.get(key)
    if (record === undefined) {
      return undefined
    }
    if (nowMs - record.storedAt >= XERO_IDEMPOTENCY_RETENTION_MS) {
      idempotencyRecords.delete(key)
      return undefined
    }
    return record
  }

  const storeIdempotency = (record: StoredIdempotencyRecord): void => {
    idempotencyRecords.set(record.key, record)
  }

  const replayOrConflict = <A>(
    key: string,
    method: "POST",
    target: XeroTestIdempotencyTarget,
    body: unknown,
    replay: (record: StoredIdempotencyRecord) => A | undefined,
  ): Effect.Effect<A | undefined, XeroInvoiceError> => {
    const record = unexpiredIdempotency(key)
    if (record === undefined) {
      return Effect.succeed(undefined)
    }
    const fingerprint = xeroIdempotencyFingerprint({ method, target, body })
    if (
      record.method !== method ||
      record.target !== target ||
      record.fingerprint !== fingerprint
    ) {
      return Effect.fail(xeroIdempotencyConflictError())
    }
    const replayed = replay(record)
    if (replayed === undefined) {
      return Effect.fail(xeroIdempotencyConflictError())
    }
    return Effect.succeed(replayed)
  }

  const commitWrite = <A>(
    operation: XeroIdempotencyOperation,
    record: StoredIdempotencyRecord,
    value: A,
  ): Effect.Effect<A, XeroInvoiceError> => {
    storeIdempotency(record)
    if (pendingTimeouts.has(operation)) {
      pendingTimeouts.delete(operation)
      return Effect.fail(
        xeroTimeoutError("Xero request timed out after commit"),
      )
    }
    const commitFailure = pendingCommitFailures.get(operation)
    if (commitFailure !== undefined) {
      pendingCommitFailures.delete(operation)
      return Effect.fail(toScriptedError(commitFailure))
    }
    return Effect.succeed(value)
  }

  const createStoredContact = (
    input: IssueAuthorisedSalesInvoiceInput,
    name: string,
    idempotencyKey: string,
  ): Effect.Effect<ResolvedXeroContact, XeroInvoiceError> =>
    Effect.gen(function* () {
      const body = {
        name,
        email: input.customer.email,
        street: shippingToStreet(input.shippingAddress),
      }
      const replayed = yield* replayOrConflict(
        idempotencyKey,
        "POST",
        "/Contacts",
        body,
        (record) => record.contact,
      )
      if (replayed !== undefined) {
        return replayed
      }
      yield* consumeRateBudget()
      if (findStoredByName(name).length > 0) {
        return yield* xeroValidationError(XERO_CONTACT_NAME_MUST_BE_UNIQUE)
      }
      const contact: XeroTestContact = {
        contactId: allocateContactId(),
        name,
        email: input.customer.email,
        addresses: [shippingToStreet(input.shippingAddress)],
      }
      contacts.push(contact)
      const resolved = toResolved(contact)
      const operation: XeroIdempotencyOperation =
        name === input.customer.name
          ? "contact.create"
          : "contact.create.conflict"
      return yield* commitWrite(
        operation,
        {
          key: idempotencyKey,
          method: "POST",
          target: "/Contacts",
          fingerprint: xeroIdempotencyFingerprint({
            method: "POST",
            target: "/Contacts",
            body,
          }),
          storedAt: nowMs,
          contact: resolved,
        },
        resolved,
      )
    })

  const updateStoredContact = (
    resolved: ResolvedXeroContact,
    input: IssueAuthorisedSalesInvoiceInput,
    idempotencyKey: string,
  ): Effect.Effect<ResolvedXeroContact, XeroInvoiceError> =>
    Effect.gen(function* () {
      const body = {
        contactId: resolved.contactId,
        name: input.customer.name,
        email: input.customer.email,
        street: shippingToStreet(input.shippingAddress),
      }
      const replayed = yield* replayOrConflict(
        idempotencyKey,
        "POST",
        "/Contacts",
        body,
        (record) => record.contact,
      )
      if (replayed !== undefined) {
        return replayed
      }
      yield* consumeRateBudget()
      const index = contacts.findIndex(
        (candidate) => candidate.contactId === resolved.contactId,
      )
      const existing = index >= 0 ? contacts[index] : undefined
      if (existing === undefined || index < 0) {
        return yield* xeroValidationError("Xero contact was not found")
      }
      const nameTaken = contacts.some(
        (candidate) =>
          candidate.name === input.customer.name &&
          candidate.contactId !== existing.contactId,
      )
      if (nameTaken) {
        return yield* xeroValidationError(XERO_CONTACT_NAME_MUST_BE_UNIQUE)
      }
      const updated: XeroTestContact = {
        contactId: existing.contactId,
        name: input.customer.name,
        email: input.customer.email,
        addresses: replaceStreetAddress(
          existing.addresses,
          shippingToStreet(input.shippingAddress),
        ),
      }
      contacts[index] = updated
      const next = toResolved(updated)
      return yield* commitWrite(
        "contact.update",
        {
          key: idempotencyKey,
          method: "POST",
          target: "/Contacts",
          fingerprint: xeroIdempotencyFingerprint({
            method: "POST",
            target: "/Contacts",
            body,
          }),
          storedAt: nowMs,
          contact: next,
        },
        next,
      )
    })

  const createStoredInvoice = (
    input: IssueAuthorisedSalesInvoiceInput,
    contactId: string,
    inclusiveCents: number,
    taxCents: number,
    idempotencyKey: string,
  ): Effect.Effect<IssuedSalesInvoice, XeroInvoiceError> =>
    Effect.gen(function* () {
      const body = {
        type: "ACCREC",
        status: "AUTHORISED",
        contactId,
        date: input.date,
        dueDate: input.dueDate,
        currency: input.currency,
        reference: input.reference,
        itemCode: input.productSku,
        unitAmount: input.agreedPrice,
      }
      const replayed = yield* replayOrConflict(
        idempotencyKey,
        "POST",
        "/Invoices",
        body,
        (record) => record.invoice,
      )
      if (replayed !== undefined) {
        return replayed
      }
      yield* consumeRateBudget()
      yield* consumeScriptedFailure(CREATE_FAILURE_KINDS)
      const identity = allocateInvoiceIdentity()
      const invoice: XeroTestInvoice = {
        invoiceId: identity.invoiceId,
        invoiceNumber: identity.invoiceNumber,
        type: "ACCREC",
        status: "AUTHORISED",
        currency: input.currency,
        reference: input.reference,
        date: input.date,
        dueDate: input.dueDate,
        lineAmountTypes: "Inclusive",
        contactId,
        lines: [
          {
            itemCode: input.productSku,
            description: input.productSku,
            quantity: "1",
            unitAmount: input.agreedPrice,
          },
        ],
        total: input.agreedPrice,
        totalTax: centsToMoney(taxCents),
        subTotal: centsToMoney(inclusiveCents - taxCents),
      }
      invoices.push(invoice)
      const issued = yield* decodeIssuedSalesInvoice(
        invoice.invoiceId,
        invoice.invoiceNumber,
      )
      return yield* commitWrite(
        "invoice.create",
        {
          key: idempotencyKey,
          method: "POST",
          target: "/Invoices",
          fingerprint: xeroIdempotencyFingerprint({
            method: "POST",
            target: "/Invoices",
            body,
          }),
          storedAt: nowMs,
          invoice: issued,
        },
        issued,
      )
    })

  const issueAuthorisedSalesInvoice = (
    input: IssueAuthorisedSalesInvoiceInput,
  ): Effect.Effect<
    IssuedSalesInvoice,
    XeroInvoiceError,
    CurrentStepJobContext
  > =>
    Effect.gen(function* () {
      const { todoId } = yield* CurrentStepJobContext
      yield* consumeScriptedFailure(IMMEDIATE_FAILURE_KINDS)
      const contactId = yield* resolveInvoiceContact(
        {
          findByName: (name) =>
            Effect.succeed(findStoredByName(name).map(toResolved)),
          findByEmail: (email) =>
            Effect.succeed(findStoredByEmail(email).map(toResolved)),
          create: createStoredContact,
          update: updateStoredContact,
        },
        input,
        todoId,
      )

      const item = items.find(
        (candidate) => candidate.itemCode === input.productSku,
      )
      if (item === undefined) {
        return yield* xeroUnknownItemCodeError(input.productSku)
      }

      const existing = findStoredByReference(input.reference).map(
        toReconcilable,
      )
      const reconciled = yield* reconcileExistingInvoices(
        existing,
        input,
        contactId,
      )
      if (reconciled !== undefined) {
        return reconciled
      }

      const inclusiveCents = yield* moneyToCents(input.agreedPrice)
      const taxCents = inclusiveTaxCents(inclusiveCents, item.taxPercent)
      const issued = yield* createStoredInvoice(
        input,
        contactId,
        inclusiveCents,
        taxCents,
        xeroIdempotencyKey(todoId, "invoice.create"),
      )

      yield* Effect.log("Issued Xero Sales Invoice").pipe(
        Effect.annotateLogs({
          reference: input.reference,
          invoiceId: issued.invoiceId,
          invoiceNumber: issued.invoiceNumber,
          customerName: input.customer.name,
          customerEmail: input.customer.email,
          productSku: input.productSku,
        }),
      )

      return issued
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Xero Sales Invoice failed").pipe(
          Effect.annotateLogs({
            reference: input.reference,
            customerName: input.customer.name,
            customerEmail: input.customer.email,
            code: error.code ?? "unknown",
            retryable: error.retryable,
          }),
        ),
      ),
    )

  const controller: XeroInvoiceTestController = {
    seedItem: (item) => {
      items.push({ ...item })
    },
    seedContact: (contact) => {
      const stored: XeroTestContact = {
        contactId: allocateContactId(contact.contactId),
        name: contact.name,
        email: contact.email,
        addresses: (contact.addresses ?? []).map(cloneAddress),
      }
      contacts.push(stored)
      return cloneContact(stored)
    },
    seedInvoice: (invoice) => {
      const identity = allocateInvoiceIdentity({
        ...(invoice.invoiceId !== undefined && {
          invoiceId: invoice.invoiceId,
        }),
        ...(invoice.invoiceNumber !== undefined && {
          invoiceNumber: invoice.invoiceNumber,
        }),
      })
      const stored: XeroTestInvoice = {
        invoiceId: identity.invoiceId,
        invoiceNumber: identity.invoiceNumber,
        type: invoice.type ?? "ACCREC",
        status: invoice.status ?? "AUTHORISED",
        currency: invoice.currency ?? "NZD",
        reference: invoice.reference,
        date: invoice.date,
        dueDate: invoice.dueDate,
        lineAmountTypes: "Inclusive",
        contactId: invoice.contactId,
        lines: [
          {
            itemCode: invoice.itemCode,
            description: invoice.itemCode,
            quantity: "1",
            unitAmount: invoice.unitAmount,
          },
        ],
        total: invoice.total,
        totalTax: invoice.totalTax,
        subTotal: invoice.subTotal,
      }
      invoices.push(stored)
      return cloneInvoice(stored)
    },
    seedIdempotencyWrite: (write) => {
      storeIdempotency({
        key: write.key,
        method: write.method,
        target: write.target,
        fingerprint: xeroIdempotencyFingerprint({
          method: write.method,
          target: write.target,
          body: write.body,
        }),
        storedAt: nowMs,
      })
    },
    seedRateBudget: (budget) => {
      rateRemaining = budget.remaining
      rateRetryAfterSeconds = budget.retryAfterSeconds ?? 1
    },
    scriptFailure: (failure) => {
      if (
        (failure.kind === "timeout" || failure.kind === "provider_server") &&
        failure.afterCommit === true
      ) {
        pendingCommitFailures.set(
          failure.operation ?? "invoice.create",
          failure,
        )
        return
      }
      scriptedFailures.push(failure)
    },
    scriptTimeoutAfterCommit: (operation) => {
      pendingTimeouts.add(operation)
    },
    now: () => nowMs,
    setNow: (epochMilliseconds) => {
      nowMs = epochMilliseconds
    },
    advanceTime: (durationMilliseconds) => {
      nowMs += durationMilliseconds
    },
    listItems: () => items.map((item) => ({ ...item })),
    listContacts: () => contacts.map(cloneContact),
    listInvoices: () => invoices.map(cloneInvoice),
    listIdempotencyKeys: () =>
      [...idempotencyRecords.values()]
        .filter(
          (record) => nowMs - record.storedAt < XERO_IDEMPOTENCY_RETENTION_MS,
        )
        .map((record) => ({
          key: record.key,
          method: record.method,
          target: record.target,
          expiresAt: record.storedAt + XERO_IDEMPOTENCY_RETENTION_MS,
        })),
    findContactByEmail: (email) => findStoredByEmail(email).map(cloneContact),
    findContactByName: (name) => findStoredByName(name).map(cloneContact),
    findInvoiceByReference: (reference) =>
      findStoredByReference(reference).map(cloneInvoice),
    clear: () => {
      items.length = 0
      contacts.length = 0
      invoices.length = 0
      idempotencyRecords.clear()
      pendingTimeouts.clear()
      scriptedFailures.length = 0
      pendingCommitFailures.clear()
      nextContactSequence = 1
      nextInvoiceSequence = 1
      nowMs = DEFAULT_NOW_MS
      rateRemaining = undefined
      rateRetryAfterSeconds = 1
    },
  }

  return {
    controller,
    layer: Layer.succeed(XeroInvoice, { issueAuthorisedSalesInvoice }),
  }
}
