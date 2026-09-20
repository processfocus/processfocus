import { describe, expect, test } from "vitest"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  collectMetricControlUrlState,
  keepPreviousMetricDetail,
} from "../app/(protected)/lists/hooks/metric-control-url-state"

const components = {
  costs: {
    _tag: FormComponentType.MetricBreakdown,
    field: "usageCosts",
    label: "Usage costs",
    title: "Usage costs",
    dataSource: "item",
    controls: [
      {
        type: "selector",
        name: "usageCostsPeriod",
        urlParameter: "period",
        label: "Period (UTC)",
        value: "last-30-days",
        options: [
          { label: "Last 30 days", value: "last-30-days" },
          { label: "Current month", value: "current-month" },
        ],
      },
    ],
    buckets: [],
  },
} as const

describe("metric control URL state", () => {
  test("defaults missing period to last-30-days and stores it in the URL state", () => {
    const state = collectMetricControlUrlState(
      components,
      new URLSearchParams("tab=costs"),
    )

    expect(state.values).toEqual({ usageCostsPeriod: "last-30-days" })
    expect(state.search).toBe("tab=costs&period=last-30-days")
    expect(state.normalized).toBe(true)
  })

  test("keeps supported period values", () => {
    const state = collectMetricControlUrlState(
      components,
      new URLSearchParams("period=current-month"),
    )

    expect(state.values).toEqual({ usageCostsPeriod: "current-month" })
    expect(state.search).toBe("period=current-month")
    expect(state.normalized).toBe(false)
  })

  test("normalizes invalid period values to last-30-days", () => {
    const state = collectMetricControlUrlState(
      components,
      new URLSearchParams("period=last_30_days"),
    )

    expect(state.values).toEqual({ usageCostsPeriod: "last-30-days" })
    expect(state.search).toBe("period=last-30-days")
    expect(state.normalized).toBe(true)
  })

  test("ignores missing component metadata", () => {
    const state = collectMetricControlUrlState(
      null,
      new URLSearchParams("period=current-month"),
    )

    expect(state.values).toEqual({})
    expect(state.search).toBe("period=current-month")
    expect(state.normalized).toBe(false)
  })

  test("ignores malformed controls without a fallback value", () => {
    const malformedComponents = {
      costs: {
        _tag: FormComponentType.MetricBreakdown,
        field: "usageCosts",
        label: "Usage costs",
        title: "Usage costs",
        dataSource: "item",
        controls: [
          {
            type: "selector",
            name: "usageCostsPeriod",
            urlParameter: "period",
            label: "Period (UTC)",
            options: [],
          },
        ],
        buckets: [],
      },
    } as unknown as typeof components

    const state = collectMetricControlUrlState(
      malformedComponents,
      new URLSearchParams("period=current-month"),
    )

    expect(state.values).toEqual({})
    expect(state.search).toBe("period=current-month")
    expect(state.normalized).toBe(false)
  })

  test("keeps previous metric detail available while a period refetch is pending", () => {
    const previousDetail = { usageCosts: { total: 42 } }

    expect(keepPreviousMetricDetail(previousDetail)).toBe(previousDetail)
    expect(keepPreviousMetricDetail(undefined)).toBeUndefined()
  })
})
