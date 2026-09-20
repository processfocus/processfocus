import { Effect } from "effect"
import { type XeroInvoiceError, xeroValidationError } from "./errors"
import type { ExactMoney } from "./identities"

export const moneyToCents = (
  amount: ExactMoney,
): Effect.Effect<number, XeroInvoiceError> => {
  const [dollars, cents] = amount.split(".")
  if (dollars === undefined || cents === undefined) {
    return Effect.fail(xeroValidationError("Agreed Price is not exact money"))
  }

  return Effect.succeed(
    Number.parseInt(dollars, 10) * 100 + Number.parseInt(cents, 10),
  )
}

export const centsToMoney = (cents: number): string => {
  const absolute = Math.abs(cents)
  const dollars = Math.floor(absolute / 100)
  const remainder = absolute % 100
  const sign = cents < 0 ? "-" : ""
  return `${sign}${String(dollars)}.${String(remainder).padStart(2, "0")}`
}

export const inclusiveTaxCents = (
  inclusiveCents: number,
  taxPercent: number,
): number => {
  if (taxPercent === 0) {
    return 0
  }

  return Math.round((inclusiveCents * taxPercent) / (100 + taxPercent))
}
