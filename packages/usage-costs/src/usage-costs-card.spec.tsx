import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import {
  FormComponentType,
  type MetricBreakdown,
} from "@pf/form-client-representation/types"
import {
  type GraphqlRequester,
  UsageCostsCard,
  type UsageCostsCardProps,
} from "./usage-costs-card"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const baseComponent = {
  _tag: FormComponentType.MetricBreakdown,
  field: "usageCosts",
  label: "Usage costs",
  title: "Usage costs",
  currency: "USD",
  dataSource: "item",
  fields: [{ label: "Currency", value: "USD" }],
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
        { label: "Last month", value: "last-month" },
      ],
    },
  ],
  buckets: [
    {
      label: "Deploy",
      amount: 12,
      color: "sky",
      description: "Deployment activity",
    },
    {
      label: "Database",
      amount: 8,
      color: "violet",
      description: "Database usage",
    },
  ],
} satisfies MetricBreakdown

const usageCostRow = {
  id: "row-1",
  usageDate: "2026-07-01",
  costCategory: "Deploy",
  costSource: "codebuild",
  durationMs: 1200,
  amount: 0.42,
}

type MockGraphqlClient = GraphqlRequester & {
  readonly request: GraphqlRequester["request"] & {
    mock: {
      calls: readonly unknown[]
    }
  }
}

const asGraphqlRequest = (
  implementation: (
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<unknown>,
): GraphqlRequester["request"] => implementation as GraphqlRequester["request"]

const createGraphqlClient = (
  request: GraphqlRequester["request"] = asGraphqlRequest(() =>
    Promise.resolve({
      listEnvironmentUsageCostRows: { items: [usageCostRow] },
    }),
  ),
): MockGraphqlClient =>
  ({
    request: mock(request),
  }) as unknown as MockGraphqlClient

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("UsageCostsCard", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com/environments/env-1")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
  })

  test("renders summary buckets and switches to the table view", async () => {
    const deferred = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() => deferred.promise),
    )

    await act(async () => {
      root.render(<UsageCostsCard {...defaultProps({ graphqlClient })} />)
    })

    expect(container.textContent).toContain("Usage costs")
    expect(container.textContent).toContain("Deploy")
    expect(container.textContent).toContain("Database")
    expect(container.textContent).toContain("$20.00")
    expect(container.querySelector("table")).toBeNull()

    await clickButton(container, "table")

    expect(container.querySelector("table")).not.toBeNull()
    expect(container.textContent).toContain("Loading usage cost rows...")
    expect(graphqlClient.request).toHaveBeenCalledTimes(1)
    expect(graphqlClient.request).toHaveBeenCalledWith(
      expect.stringContaining("listEnvironmentUsageCostRows"),
      {
        environmentId: "env-1",
        usageCostsPeriod: "last-30-days",
      },
    )

    await act(async () => {
      deferred.resolve({
        listEnvironmentUsageCostRows: { items: [usageCostRow] },
      })
      await deferred.promise
    })

    expect(container.textContent).toContain("2026-07-01")
    expect(container.textContent).toContain("Deploy")
    expect(container.textContent).toContain("$0.42")
    expect(container.textContent).not.toContain("Loading usage cost rows...")
  })

  test("refetches rows when the period control changes", async () => {
    const first = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    const second = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    let callCount = 0
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() => {
        callCount += 1
        return callCount === 1 ? first.promise : second.promise
      }),
    )

    await act(async () => {
      root.render(<UsageCostsCard {...defaultProps({ graphqlClient })} />)
    })

    await clickButton(container, "table")
    expect(container.textContent).toContain("Loading usage cost rows...")

    await act(async () => {
      first.resolve({
        listEnvironmentUsageCostRows: { items: [usageCostRow] },
      })
      await first.promise
    })

    expect(container.textContent).toContain("2026-07-01")
    expect(window.location.search).toBe("")

    const periodSelect = container.querySelector(
      'select[name="usageCostsPeriod"]',
    ) as HTMLSelectElement | null
    expect(periodSelect).not.toBeNull()

    await act(async () => {
      periodSelect!.value = "current-month"
      periodSelect!.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(window.location.search).toBe("?period=current-month")
    expect(container.textContent).toContain("Loading usage cost rows...")
    expect(graphqlClient.request).toHaveBeenCalledTimes(2)
    expect(graphqlClient.request).toHaveBeenLastCalledWith(
      expect.stringContaining("listEnvironmentUsageCostRows"),
      {
        environmentId: "env-1",
        usageCostsPeriod: "current-month",
      },
    )

    await act(async () => {
      second.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "row-2",
              usageDate: "2026-07-15",
              amount: 1.25,
            },
          ],
        },
      })
      await second.promise
    })

    expect(container.textContent).toContain("2026-07-15")
    expect(container.textContent).toContain("$1.25")
    expect(container.textContent).not.toContain("Loading usage cost rows...")
  })

  test("shows empty and error table outcomes", async () => {
    const emptyClient = createGraphqlClient(
      asGraphqlRequest(() =>
        Promise.resolve({
          listEnvironmentUsageCostRows: { items: [] },
        }),
      ),
    )

    await act(async () => {
      root.render(
        <UsageCostsCard {...defaultProps({ graphqlClient: emptyClient })} />,
      )
    })

    await clickButton(container, "table")
    await flushMicrotasks()

    expect(container.textContent).toContain(
      "No usage cost rows for this period.",
    )

    await act(async () => {
      root.unmount()
    })
    root = createRoot(container)

    const failingClient = createGraphqlClient(
      asGraphqlRequest(() => Promise.reject(new Error("GraphQL unavailable"))),
    )

    await act(async () => {
      root.render(
        <UsageCostsCard {...defaultProps({ graphqlClient: failingClient })} />,
      )
    })

    await clickButton(container, "table")
    await flushMicrotasks()

    expect(container.textContent).toContain("GraphQL unavailable")
  })

  test("uses the project usage-cost query when the subject changes", async () => {
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() =>
        Promise.resolve({
          listProjectUsageCostRows: {
            items: [
              {
                ...usageCostRow,
                id: "project-row",
                costCategory: "Project deploy",
              },
            ],
          },
        }),
      ),
    )

    await act(async () => {
      root.render(
        <UsageCostsCard
          {...defaultProps({
            graphqlClient,
            usageCostsSubject: "project",
            values: {
              id: "project-1",
              usageCosts: {
                total: 20,
                currency: "USD",
                buckets: baseComponent.buckets,
              },
            },
          })}
        />,
      )
    })

    await clickButton(container, "table")
    await flushMicrotasks()

    expect(graphqlClient.request).toHaveBeenCalledWith(
      expect.stringContaining("listProjectUsageCostRows"),
      {
        projectId: "project-1",
        usageCostsPeriod: "last-30-days",
      },
    )
    expect(container.textContent).toContain("Project deploy")
  })

  test("resets the selected period when component controls change", async () => {
    const first = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    const second = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    let callCount = 0
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() => {
        callCount += 1
        return callCount === 1 ? first.promise : second.promise
      }),
    )
    const initialProps = defaultProps({ graphqlClient })

    await act(async () => {
      root.render(<UsageCostsCard {...initialProps} />)
    })

    await clickButton(container, "table")
    await act(async () => {
      first.resolve({
        listEnvironmentUsageCostRows: { items: [usageCostRow] },
      })
      await first.promise
    })
    expect(container.textContent).toContain("2026-07-01")

    const periodSelect = container.querySelector(
      'select[name="usageCostsPeriod"]',
    ) as HTMLSelectElement | null
    expect(periodSelect?.value).toBe("last-30-days")

    await act(async () => {
      periodSelect!.value = "last-month"
      periodSelect!.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(periodSelect?.value).toBe("last-month")
    expect(window.location.search).toBe("?period=last-month")
    expect(container.textContent).toContain("Loading usage cost rows...")

    window.history.replaceState(null, "", "/environments/env-1")

    await act(async () => {
      root.render(
        <UsageCostsCard
          {...initialProps}
          component={{
            ...baseComponent,
            controls: [
              {
                type: "selector",
                name: "usageCostsPeriod",
                urlParameter: "period",
                label: "Period (UTC)",
                value: "current-month",
                options: [
                  { label: "Current month", value: "current-month" },
                  { label: "Last 2 months", value: "last-2-months" },
                ],
              },
            ],
          }}
        />,
      )
    })

    const resetSelect = container.querySelector(
      'select[name="usageCostsPeriod"]',
    ) as HTMLSelectElement | null
    expect(resetSelect?.value).toBe("current-month")
    expect(container.textContent).toContain("Loading usage cost rows...")
    expect(graphqlClient.request).toHaveBeenLastCalledWith(
      expect.stringContaining("listEnvironmentUsageCostRows"),
      {
        environmentId: "env-1",
        usageCostsPeriod: "current-month",
      },
    )

    await act(async () => {
      second.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "row-control-reset",
              usageDate: "2026-07-22",
              amount: 3.5,
            },
          ],
        },
      })
      await second.promise
    })

    expect(container.textContent).toContain("2026-07-22")
    expect(container.textContent).toContain("$3.50")
  })

  test("updates summary totals when values change", async () => {
    const graphqlClient = createGraphqlClient()

    await act(async () => {
      root.render(<UsageCostsCard {...defaultProps({ graphqlClient })} />)
    })

    expect(container.textContent).toContain("$20.00")

    await act(async () => {
      root.render(
        <UsageCostsCard
          {...defaultProps({
            graphqlClient,
            values: {
              id: "env-1",
              usageCosts: {
                total: 42.5,
                currency: "USD",
                buckets: [
                  { label: "Deploy", amount: 30, color: "sky" },
                  { label: "Database", amount: 12.5, color: "violet" },
                ],
              },
            },
          })}
        />,
      )
    })

    expect(container.textContent).toContain("$42.50")
    expect(container.textContent).toContain("$30.00")
  })

  test("refetches when the subject item id changes after a successful load", async () => {
    const firstClient = createGraphqlClient(
      asGraphqlRequest(() =>
        Promise.resolve({
          listEnvironmentUsageCostRows: { items: [usageCostRow] },
        }),
      ),
    )

    await act(async () => {
      root.render(
        <UsageCostsCard {...defaultProps({ graphqlClient: firstClient })} />,
      )
    })

    await clickButton(container, "table")
    await flushMicrotasks()
    expect(container.textContent).toContain("2026-07-01")

    const secondClient = createGraphqlClient(
      asGraphqlRequest(() =>
        Promise.resolve({
          listEnvironmentUsageCostRows: {
            items: [
              {
                ...usageCostRow,
                id: "row-env-2",
                usageDate: "2026-07-20",
                costCategory: "Execution",
              },
            ],
          },
        }),
      ),
    )

    await act(async () => {
      root.render(
        <UsageCostsCard
          {...defaultProps({
            graphqlClient: secondClient,
            values: {
              id: "env-2",
              usageCosts: {
                total: 20,
                currency: "USD",
                buckets: baseComponent.buckets,
              },
            },
          })}
        />,
      )
    })

    await flushMicrotasks()

    expect(secondClient.request).toHaveBeenCalledWith(
      expect.stringContaining("listEnvironmentUsageCostRows"),
      {
        environmentId: "env-2",
        usageCostsPeriod: "last-30-days",
      },
    )
    expect(container.textContent).toContain("2026-07-20")
    expect(container.textContent).toContain("Execution")
  })

  test("shows loading again when re-entering the table after leaving it", async () => {
    const first = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    const second = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    let callCount = 0
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() => {
        callCount += 1
        return callCount === 1 ? first.promise : second.promise
      }),
    )

    await act(async () => {
      root.render(<UsageCostsCard {...defaultProps({ graphqlClient })} />)
    })

    await clickButton(container, "table")
    await act(async () => {
      first.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "stale-row",
              usageDate: "2026-06-01",
              costCategory: "Stale",
            },
          ],
        },
      })
      await first.promise
    })
    expect(container.textContent).toContain("Stale")

    await clickButton(container, "summary")
    expect(container.querySelector("table")).toBeNull()

    await clickButton(container, "table")
    expect(container.textContent).toContain("Loading usage cost rows...")
    expect(container.textContent).not.toContain("Stale")
    expect(graphqlClient.request).toHaveBeenCalledTimes(2)

    await act(async () => {
      second.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "fresh-row",
              usageDate: "2026-07-30",
              costCategory: "Fresh",
            },
          ],
        },
      })
      await second.promise
    })

    expect(container.textContent).toContain("Fresh")
    expect(container.textContent).not.toContain("Stale")
  })

  test("ignores a slower response from a previous period after switching", async () => {
    const first = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    const second = createDeferred<{
      listEnvironmentUsageCostRows: { items: (typeof usageCostRow)[] }
    }>()
    let callCount = 0
    const graphqlClient = createGraphqlClient(
      asGraphqlRequest(() => {
        callCount += 1
        return callCount === 1 ? first.promise : second.promise
      }),
    )

    await act(async () => {
      root.render(<UsageCostsCard {...defaultProps({ graphqlClient })} />)
    })

    await clickButton(container, "table")
    expect(container.textContent).toContain("Loading usage cost rows...")

    const periodSelect = container.querySelector(
      'select[name="usageCostsPeriod"]',
    ) as HTMLSelectElement | null
    expect(periodSelect).not.toBeNull()

    await act(async () => {
      periodSelect!.value = "current-month"
      periodSelect!.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(container.textContent).toContain("Loading usage cost rows...")
    expect(graphqlClient.request).toHaveBeenCalledTimes(2)

    await act(async () => {
      first.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "late-a",
              usageDate: "2026-05-01",
              costCategory: "Period A",
            },
          ],
        },
      })
      await first.promise
    })

    expect(container.textContent).not.toContain("Period A")
    expect(container.textContent).toContain("Loading usage cost rows...")

    await act(async () => {
      second.resolve({
        listEnvironmentUsageCostRows: {
          items: [
            {
              ...usageCostRow,
              id: "b-row",
              usageDate: "2026-07-18",
              costCategory: "Period B",
            },
          ],
        },
      })
      await second.promise
    })

    expect(container.textContent).toContain("Period B")
    expect(container.textContent).toContain("2026-07-18")
    expect(container.textContent).not.toContain("Period A")
  })
})

const defaultProps = (
  overrides: Partial<UsageCostsCardProps> & {
    readonly graphqlClient: GraphqlRequester
  },
): UsageCostsCardProps => ({
  component: baseComponent,
  usageCostsSubject: "environment",
  values: {
    id: "env-1",
    usageCosts: {
      total: 20,
      currency: "USD",
      buckets: baseComponent.buckets,
    },
  },
  ...overrides,
})

const clickButton = async (
  container: HTMLElement,
  label: string,
): Promise<void> => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  expect(button).toBeDefined()

  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const installDom = (url: string): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })
  const scope = globalThis as typeof globalThis & {
    Event?: typeof Event
    HTMLElement?: typeof HTMLElement
    IS_REACT_ACT_ENVIRONMENT?: boolean
    MouseEvent?: typeof MouseEvent
  }
  const previousIsReactActEnvironment = scope.IS_REACT_ACT_ENVIRONMENT

  const previousGlobals = {
    document: globalThis.document,
    Event: scope.Event,
    history: globalThis.history,
    HTMLElement: scope.HTMLElement,
    MouseEvent: scope.MouseEvent,
    navigator: globalThis.navigator,
    window: globalThis.window,
  }

  Object.assign(scope, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    Event: dom.window.Event,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)

    if (previousIsReactActEnvironment === undefined) {
      delete scope.IS_REACT_ACT_ENVIRONMENT
    } else {
      scope.IS_REACT_ACT_ENVIRONMENT = previousIsReactActEnvironment
    }
  }
}
