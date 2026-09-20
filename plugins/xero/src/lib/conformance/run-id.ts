const REFERENCE_PREFIX = "PF"

export interface ConformanceRun {
  readonly id: string
  readonly date: string
}

const aucklandCalendarDate = (epochMilliseconds: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMilliseconds))

export const createConformanceRun = (
  epochMilliseconds: number = Date.now(),
  random: () => string = () => crypto.randomUUID(),
): ConformanceRun => {
  const randomPart = random().replaceAll("-", "").slice(0, 8)
  return {
    id: `${epochMilliseconds.toString(36)}${randomPart}`,
    date: aucklandCalendarDate(epochMilliseconds),
  }
}

export const uniqueOrderNumberReference = (
  run: ConformanceRun,
  scenario: string,
): string => `${REFERENCE_PREFIX}${run.id}${scenario}`

export const uniqueTodoId = (run: ConformanceRun, scenario: string): string =>
  `todo-${run.id}-${scenario}`

export const uniqueCustomerName = (
  run: ConformanceRun,
  scenario: string,
): string => `PF Canary ${run.id} ${scenario}`

export const uniqueCustomerEmail = (
  run: ConformanceRun,
  scenario: string,
): string => `pf-canary-${run.id}-${scenario.toLowerCase()}@example.com`
