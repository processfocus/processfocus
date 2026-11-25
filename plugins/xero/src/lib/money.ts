export const invoiceLinesTotalCents = (
  lines: readonly { readonly quantity: number; readonly unitAmount: string }[],
): bigint =>
  lines.reduce(
    (total, line) =>
      total + BigInt(line.quantity) * BigInt(line.unitAmount.replace(".", "")),
    0n,
  )

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
