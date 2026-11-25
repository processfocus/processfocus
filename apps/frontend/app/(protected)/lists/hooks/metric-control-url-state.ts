import type { MetricBreakdownOptions } from "@pf/form-schema"

const graphqlNamePattern = /^[_A-Za-z][_0-9A-Za-z]*$/

const isGraphqlName = (value: string) => graphqlNamePattern.test(value)

export interface MetricControlUrlState {
  readonly values: Record<string, string>
  readonly search: string
  readonly normalized: boolean
}

export const keepPreviousMetricDetail = <T>(
  previousData: T | undefined,
): T | undefined => previousData

export const collectMetricControlUrlState = (
  metrics: Record<string, MetricBreakdownOptions> | null,
  searchParams: URLSearchParams,
): MetricControlUrlState => {
  const values = new Map<string, string>()
  const normalizedSearchParams = new URLSearchParams(searchParams)
  let normalized = false

  const collect = (component: MetricBreakdownOptions) => {
    if (component.dataSource !== "item") {
      return
    }

    for (const control of component.controls ?? []) {
      if (!isGraphqlName(control.name)) continue

      const fallbackValue = control.value ?? control.options[0]?.value
      if (fallbackValue === undefined) continue

      const searchKey = control.urlParameter ?? control.name
      const searchValue = searchParams.get(searchKey)
      const selectedValue =
        searchValue !== null &&
        control.options.some((option) => option.value === searchValue)
          ? searchValue
          : fallbackValue

      values.set(control.name, selectedValue)

      if (searchValue !== selectedValue) {
        normalizedSearchParams.set(searchKey, selectedValue)
        normalized = true
      }
    }
  }

  if (metrics) {
    Object.values(metrics).forEach(collect)
  }

  return {
    normalized,
    search: normalizedSearchParams.toString(),
    values: Object.fromEntries(values),
  }
}
