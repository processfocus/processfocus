"use client"

import { useEffect, useEffectEvent, useState } from "react"
import type {
  MetricBreakdown,
  MetricBreakdownBucket,
  MetricBreakdownColor,
  MetricBreakdownControl,
  MetricBreakdownField,
} from "@pf/form-client-representation/types"

export type UsageCostsSubject = "environment" | "project"

export interface GraphqlRequester {
  readonly request: <T>(
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<T>
}

interface UsageCostRow {
  readonly id: string
  readonly usageDate: string
  readonly costCategory: string
  readonly costSource: string
  readonly durationMs: number | null
  readonly amount: number
}

type UsageCostsView = "summary" | "table"

const metricBreakdownBarClassNames = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  slate: "bg-slate-500",
  violet: "bg-violet-500",
} satisfies Record<MetricBreakdownColor, string>

const usageCostsPeriodControlName = "usageCostsPeriod"

const environmentUsageCostRowsQuery = `
  query EnvironmentUsageCostRows($environmentId: String!, $usageCostsPeriod: String) {
    listEnvironmentUsageCostRows(
      environmentId: $environmentId
      usageCostsPeriod: $usageCostsPeriod
    ) {
      items {
        id
        usageDate
        costCategory
        costSource
        durationMs
        amount
      }
    }
  }
`

const projectUsageCostRowsQuery = `
  query ProjectUsageCostRows($projectId: String!, $usageCostsPeriod: String) {
    listProjectUsageCostRows(
      projectId: $projectId
      usageCostsPeriod: $usageCostsPeriod
    ) {
      items {
        id
        usageDate
        costCategory
        costSource
        durationMs
        amount
      }
    }
  }
`

const isMetricBreakdownColor = (value: string): value is MetricBreakdownColor =>
  Object.hasOwn(metricBreakdownBarClassNames, value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const readNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

const readNullableNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === "number" || value === null ? value : undefined
}

const readUsageCostRows = (value: unknown): readonly UsageCostRow[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((row) => {
    if (!isRecord(row)) return []

    const id = readString(row, "id")
    const usageDate = readString(row, "usageDate")
    const costCategory = readString(row, "costCategory")
    const costSource = readString(row, "costSource")
    const amount = readNumber(row, "amount")
    const durationMs = readNullableNumber(row, "durationMs")

    if (
      id === undefined ||
      usageDate === undefined ||
      costCategory === undefined ||
      costSource === undefined ||
      amount === undefined ||
      durationMs === undefined
    ) {
      return []
    }

    return [{ id, usageDate, costCategory, costSource, durationMs, amount }]
  })
}

const readMetricBreakdownBucket = (
  value: unknown,
): MetricBreakdownBucket | null => {
  if (!isRecord(value)) return null

  const label = readString(value, "label")
  const amount = readNumber(value, "amount")
  if (label === undefined || amount === undefined) return null

  const description = readString(value, "description")
  const color = readString(value, "color")

  return {
    label,
    amount,
    ...(description !== undefined ? { description } : {}),
    ...(color !== undefined && isMetricBreakdownColor(color) ? { color } : {}),
  }
}

const readMetricBreakdownField = (
  value: unknown,
): MetricBreakdownField | null => {
  if (!isRecord(value)) return null

  const label = readString(value, "label")
  const fieldValue = readString(value, "value")
  if (label === undefined || fieldValue === undefined) return null

  return { label, value: fieldValue }
}

export const readMetricBreakdownData = (value: unknown) => {
  if (!isRecord(value)) return undefined

  const bucketValues = value["buckets"]
  const fieldValues = value["fields"]
  const buckets = Array.isArray(bucketValues)
    ? bucketValues.flatMap((bucket) => {
        const parsed = readMetricBreakdownBucket(bucket)
        return parsed ? [parsed] : []
      })
    : []
  const fields = Array.isArray(fieldValues)
    ? fieldValues.flatMap((field) => {
        const parsed = readMetricBreakdownField(field)
        return parsed ? [parsed] : []
      })
    : []

  return {
    buckets,
    fields,
    total: readNumber(value, "total"),
    currency: readString(value, "currency"),
    badge: readString(value, "badge"),
  }
}

const metricBucketPercent = (total: number, bucket: MetricBreakdownBucket) =>
  total === 0 ? 0 : Math.round(((bucket.amount ?? 0) / total) * 100)

const metricFieldInputId = (componentField: string, label: string) =>
  `${componentField}-${label}`.replace(/[^A-Za-z0-9_-]/g, "-").toLowerCase()

const usageCostDurationLabel = (durationMs: number | null) => {
  if (durationMs === null) return "-"

  if (durationMs < 1000) return `${durationMs}ms`

  if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`

  const minutes = Math.round(durationMs / 60000)
  if (minutes < 60) return `${minutes}m`

  return `${Math.round(minutes / 60)}h`
}

const usageCostAmountFormatters = new Map<string, Intl.NumberFormat>()

export const formatUsageCostAmount = (amount: number, currency: string) => {
  const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2
  const formatterKey = `${currency}:${fractionDigits}`
  const existingFormatter = usageCostAmountFormatters.get(formatterKey)
  if (existingFormatter) return existingFormatter.format(amount)

  const formatter = new Intl.NumberFormat("en-US", {
    currency,
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 2,
    style: "currency",
  })
  usageCostAmountFormatters.set(formatterKey, formatter)
  return formatter.format(amount)
}

const readMetricContext = (
  values: Record<string, unknown>,
  contextFields: readonly string[] | undefined,
) =>
  (contextFields ?? [])
    .map((field) => values[field])
    .filter(
      (value): value is string | number =>
        (typeof value === "string" && value.length > 0) ||
        typeof value === "number",
    )
    .map(String)
    .join(" / ")

export const resolveMetricControlValue = (control: MetricBreakdownControl) => {
  const fallbackValue = control.value ?? control.options[0]?.value
  const searchValue =
    typeof window === "undefined"
      ? undefined
      : new URLSearchParams(window.location.search).get(
          control.urlParameter ?? control.name,
        )

  return searchValue !== undefined &&
    searchValue !== null &&
    control.options.some((option) => option.value === searchValue)
    ? searchValue
    : fallbackValue
}

export const updateMetricControlUrlValue = (
  control: MetricBreakdownControl,
  value: string,
) => {
  if (typeof window === "undefined") {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set(control.urlParameter ?? control.name, value)
  window.history.pushState(null, "", url)
  window.dispatchEvent(new Event("metric-breakdown-control-change"))
}

export const resolveMetricBuckets = (
  component: MetricBreakdown,
  data: ReturnType<typeof readMetricBreakdownData>,
): readonly MetricBreakdownBucket[] => {
  const dataBuckets = data?.buckets ?? []

  if (component.buckets.length === 0) {
    return dataBuckets
  }

  return component.buckets.map((bucket) => {
    const dataBucket = dataBuckets.find(
      (candidate) => candidate.label === bucket.label,
    )
    const color = dataBucket?.color ?? bucket.color
    const description = dataBucket?.description ?? bucket.description

    return {
      label: bucket.label,
      amount: dataBucket?.amount ?? bucket.amount ?? 0,
      ...(color !== undefined ? { color } : {}),
      ...(description !== undefined ? { description } : {}),
    }
  })
}

export const resolveMetricFields = (
  component: MetricBreakdown,
  data: ReturnType<typeof readMetricBreakdownData>,
): readonly MetricBreakdownField[] | undefined => {
  const dataFields = data?.fields ?? []

  if (!component.fields || component.fields.length === 0) {
    return dataFields.length > 0 ? dataFields : undefined
  }

  return component.fields.flatMap((field) => {
    const dataField = dataFields.find(
      (candidate) => candidate.label === field.label,
    )
    const value = dataField?.value ?? field.value

    return value === undefined ? [] : [{ ...field, value }]
  })
}

function MetricBreakdownControlFields({
  component,
  onControlChange,
}: {
  readonly component: Pick<MetricBreakdown, "controls" | "field">
  readonly onControlChange?: (controlName: string, value: string) => void
}) {
  if (!component.controls || component.controls.length === 0) return null

  return (
    <>
      {component.controls.map((control) => {
        const inputId = metricFieldInputId(component.field, control.name)
        const selectedValue = resolveMetricControlValue(control)

        return (
          <div
            className="space-y-2 text-sm font-medium text-slate-700 dark:text-slate-200"
            key={control.name}
          >
            <label htmlFor={inputId}>{control.label}</label>
            <select
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              data-url-parameter={control.urlParameter}
              defaultValue={selectedValue}
              id={inputId}
              key={selectedValue}
              name={control.name}
              onChange={(event) => {
                const value = event.currentTarget.value
                updateMetricControlUrlValue(control, value)
                onControlChange?.(control.name, value)
              }}
            >
              {control.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </>
  )
}

export interface UsageCostsCardProps {
  readonly component: MetricBreakdown
  readonly graphqlClient: GraphqlRequester
  readonly values: Record<string, unknown>
  readonly usageCostsSubject: UsageCostsSubject
}

interface UsageCostRowsResult {
  readonly requestKey: string
  readonly rows: readonly UsageCostRow[]
  readonly error: string | null
}

const resolveUsageCostsPeriod = (
  controls: MetricBreakdown["controls"],
): string | undefined => {
  const control = controls?.find(
    (candidate) => candidate.name === usageCostsPeriodControlName,
  )
  return control ? resolveMetricControlValue(control) : undefined
}

const usageCostRowsRequestKey = (
  view: UsageCostsView,
  itemId: string | undefined,
  usageCostsSubject: UsageCostsSubject,
  usageCostsPeriod: string | undefined,
): string | null => {
  if (view !== "table" || itemId === undefined) {
    return null
  }

  return `${usageCostsSubject}:${itemId}:${usageCostsPeriod ?? ""}`
}

export function UsageCostsCard({
  component,
  graphqlClient,
  values,
  usageCostsSubject,
}: UsageCostsCardProps) {
  const [view, setView] = useState<UsageCostsView>("summary")
  const requestUsageCostRows = useEffectEvent(
    (query: string, variables: Record<string, unknown>) =>
      graphqlClient.request<Record<string, { readonly items: unknown } | null>>(
        query,
        variables,
      ),
  )
  const resolvedUsageCostsPeriod = resolveUsageCostsPeriod(component.controls)
  const [usageCostsPeriod, setUsageCostsPeriod] = useState(
    resolvedUsageCostsPeriod,
  )
  const [
    previousResolvedUsageCostsPeriod,
    setPreviousResolvedUsageCostsPeriod,
  ] = useState(resolvedUsageCostsPeriod)
  if (resolvedUsageCostsPeriod !== previousResolvedUsageCostsPeriod) {
    setPreviousResolvedUsageCostsPeriod(resolvedUsageCostsPeriod)
    setUsageCostsPeriod(resolvedUsageCostsPeriod)
  }

  const [usageCostRowsResult, setUsageCostRowsResult] =
    useState<UsageCostRowsResult | null>(null)
  const context = readMetricContext(values, component.contextFields)
  const data = readMetricBreakdownData(values[component.field])
  const itemId = readString(values, "id")
  const buckets = resolveMetricBuckets(component, data)
  const fields = resolveMetricFields(component, data) ?? []
  const total =
    data?.total ??
    buckets.reduce((sum, bucket) => sum + (bucket.amount ?? 0), 0)
  const currency = data?.currency ?? component.currency ?? "USD"
  const badge = data?.badge ?? component.badge
  const formatter = new Intl.NumberFormat("en-US", {
    currency,
    style: "currency",
  })
  const rowsRequestKey = usageCostRowsRequestKey(
    view,
    itemId,
    usageCostsSubject,
    usageCostsPeriod,
  )
  // Drop cached table results when leaving the table so re-entry always loads
  // (including after a prior error) instead of presenting a matched stale cache.
  if (rowsRequestKey === null && usageCostRowsResult !== null) {
    setUsageCostRowsResult(null)
  }
  const usageCostRowsLoading =
    rowsRequestKey !== null &&
    usageCostRowsResult?.requestKey !== rowsRequestKey
  const usageCostRowsError =
    rowsRequestKey !== null &&
    usageCostRowsResult?.requestKey === rowsRequestKey
      ? usageCostRowsResult.error
      : null
  const usageCostRows =
    rowsRequestKey !== null &&
    usageCostRowsResult?.requestKey === rowsRequestKey
      ? usageCostRowsResult.rows
      : []

  useEffect(() => {
    if (rowsRequestKey === null || itemId === undefined) {
      return
    }

    let cancelled = false

    const query =
      usageCostsSubject === "environment"
        ? environmentUsageCostRowsQuery
        : projectUsageCostRowsQuery
    const resultKey =
      usageCostsSubject === "environment"
        ? "listEnvironmentUsageCostRows"
        : "listProjectUsageCostRows"
    const variables =
      usageCostsSubject === "environment"
        ? { environmentId: itemId, usageCostsPeriod }
        : { projectId: itemId, usageCostsPeriod }

    requestUsageCostRows(query, variables)
      .then((result) => {
        if (cancelled) return
        setUsageCostRowsResult({
          requestKey: rowsRequestKey,
          rows: readUsageCostRows(result[resultKey]?.items),
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setUsageCostRowsResult({
          requestKey: rowsRequestKey,
          rows: [],
          error:
            error instanceof Error
              ? error.message
              : "Unable to load usage cost rows.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [itemId, rowsRequestKey, usageCostsPeriod, usageCostsSubject])

  return (
    <section
      aria-label={component.title}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/80 shadow-sm dark:border-slate-800 dark:bg-slate-950/40"
    >
      <div className="border-b border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {component.title}
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">
              {formatter.format(total)}
            </p>
            {context ? (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {context}
              </p>
            ) : null}
          </div>
          {badge ? (
            <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300">
              {badge}
            </div>
          ) : null}
          <fieldset className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1 text-xs font-medium dark:border-slate-700 dark:bg-slate-950">
            <legend className="sr-only">Usage costs view</legend>
            {(["summary", "table"] as const).map((option) => (
              <button
                className={`rounded-md px-3 py-1.5 capitalize transition-colors ${
                  view === option
                    ? "bg-white text-slate-950 shadow-xs dark:bg-slate-800 dark:text-slate-50"
                    : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                }`}
                key={option}
                onClick={() => setView(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="space-y-5 p-5">
        {component.controls?.length || fields.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricBreakdownControlFields
              component={component}
              onControlChange={(controlName, value) => {
                if (controlName === usageCostsPeriodControlName) {
                  setUsageCostsPeriod(value)
                }
              }}
            />
            {fields.map((field) => {
              const inputId = metricFieldInputId(component.field, field.label)

              return (
                <div
                  className="space-y-2 text-sm font-medium text-slate-700 dark:text-slate-200"
                  key={field.label}
                >
                  <label htmlFor={inputId}>{field.label}</label>
                  <input
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    id={inputId}
                    readOnly={true}
                    value={field.value ?? ""}
                  />
                </div>
              )
            })}
          </div>
        ) : null}

        {view === "summary" ? (
          <div className="grid gap-3">
            {buckets.map((bucket) => {
              const percent = metricBucketPercent(total, bucket)
              return (
                <div
                  className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60"
                  key={bucket.label}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-slate-950 dark:text-slate-50">
                        {bucket.label}
                      </p>
                      {bucket.description ? (
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                          {bucket.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-slate-950 dark:text-slate-50">
                        {formatter.format(bucket.amount ?? 0)}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {percent}%
                      </p>
                    </div>
                  </div>
                  <div
                    aria-label={`${bucket.label} usage cost share`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={percent}
                    className="mt-4 h-2 rounded-full bg-slate-100 dark:bg-slate-800"
                    role="progressbar"
                  >
                    <div
                      className={`h-2 rounded-full ${metricBreakdownBarClassNames[bucket.color ?? "slate"]}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60">
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[6.25rem]" />
                  <col className="w-[7.25rem]" />
                  <col className="w-[4rem]" />
                  <col className="w-[5.25rem]" />
                </colgroup>
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[0.7rem] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                  <tr>
                    <th className="px-2.5 py-3">Day</th>
                    <th className="px-2.5 py-3">Category</th>
                    <th className="px-2.5 py-3 text-right">Dur.</th>
                    <th className="px-2.5 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {usageCostRowsLoading ? (
                    <tr>
                      <td
                        className="px-4 py-8 text-center text-slate-500 dark:text-slate-400"
                        colSpan={4}
                      >
                        Loading usage cost rows...
                      </td>
                    </tr>
                  ) : usageCostRowsError ? (
                    <tr>
                      <td
                        className="px-4 py-8 text-center text-rose-600 dark:text-rose-400"
                        colSpan={4}
                      >
                        {usageCostRowsError}
                      </td>
                    </tr>
                  ) : usageCostRows.length > 0 ? (
                    usageCostRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-2.5 py-3 text-slate-700 dark:text-slate-200">
                          {row.usageDate}
                        </td>
                        <td className="break-words px-2.5 py-3 text-slate-700 dark:text-slate-200">
                          {row.costCategory}
                        </td>
                        <td className="px-2.5 py-3 text-right text-slate-500 dark:text-slate-400">
                          {usageCostDurationLabel(row.durationMs)}
                        </td>
                        <td className="px-2.5 py-3 text-right font-medium text-slate-950 dark:text-slate-50">
                          {formatUsageCostAmount(row.amount, currency)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        className="px-4 py-8 text-center text-slate-500 dark:text-slate-400"
                        colSpan={4}
                      >
                        No usage cost rows for this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
