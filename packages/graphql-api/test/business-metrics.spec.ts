import { randomUUID } from "node:crypto"
import { Effect, Metric } from "effect"
import {
  makeBusinessMetricDimensionsLayer,
  recordSuccessfulProcessStart,
  resolveBusinessMetricDimensions,
} from "../src"
import { describe, expect, it } from "bun:test"

const metricSeries = (projectPrefix: string) =>
  Effect.runSync(Metric.snapshot).filter(
    (pair) =>
      pair.id === "pf.business.process.starts" &&
      String(pair.attributes?.["pf_project"] ?? "").startsWith(projectPrefix),
  )

describe("business metric dimensions", () => {
  it("does not classify an account from its id alone", () => {
    expect(
      resolveBusinessMetricDimensions({
        accountId: "111111111111",
        project: "example",
        environment: "prod",
      }).accountScope,
    ).toBe("unclassified")
  })

  it("uses runtime-supplied classification and leaves unknown accounts unclassified", () => {
    expect(
      resolveBusinessMetricDimensions({
        account: { name: "CustomerOne", scope: "customer" },
        accountId: "111111111111",
        project: "project-a",
        environment: "development",
      }),
    ).toEqual({
      accountId: "111111111111",
      accountName: "CustomerOne",
      accountScope: "customer",
      project: "project-a",
      environment: "development",
    })
    expect(
      resolveBusinessMetricDimensions({
        account: { name: "CustomerTwo", scope: "customer" },
        accountId: "222222222222",
        project: "new-project",
        environment: "staging",
      }).accountName,
    ).toBe("CustomerTwo")
    expect(
      resolveBusinessMetricDimensions({
        account: { name: "Internal", scope: "internal" },
        accountId: "333333333333",
        project: "console",
        environment: "prod",
      }).accountScope,
    ).toBe("internal")
    expect(
      resolveBusinessMetricDimensions({
        accountId: "999999999999",
        project: "unknown-project",
        environment: "prod",
      }).accountScope,
    ).toBe("unclassified")
  })

  it("exports customer starts with filter dimensions and no execution label", async () => {
    const project = `metric-test-${randomUUID()}`
    await Effect.runPromise(
      Effect.all([
        recordSuccessfulProcessStart("human"),
        recordSuccessfulProcessStart("human"),
        recordSuccessfulProcessStart("automated"),
      ]).pipe(
        Effect.provide(
          makeBusinessMetricDimensionsLayer({
            account: { name: "CustomerOne", scope: "customer" },
            accountId: "111111111111",
            project,
            environment: "staging",
          }),
        ),
      ),
    )

    const series = metricSeries(project)
    expect(series).toHaveLength(2)
    const observed = series.map((pair) => {
      if (pair.type !== "Counter") {
        throw new Error("Expected process starts to be a counter")
      }
      return {
        count: pair.state.count,
        labels: pair.attributes,
      }
    })
    expect(observed).toEqual(
      expect.arrayContaining([
        {
          count: 2,
          labels: {
            pf_account_id: "111111111111",
            pf_account_name: "CustomerOne",
            pf_account_scope: "customer",
            pf_environment: "staging",
            pf_project: project,
            pf_trigger: "human",
          },
        },
        {
          count: 1,
          labels: {
            pf_account_id: "111111111111",
            pf_account_name: "CustomerOne",
            pf_account_scope: "customer",
            pf_environment: "staging",
            pf_project: project,
            pf_trigger: "automated",
          },
        },
      ]),
    )
    expect(JSON.stringify(observed)).not.toContain("execution")
  })

  it("does not create a series for Internal or unclassified activity", async () => {
    const projectPrefix = `excluded-${randomUUID()}`
    await Effect.runPromise(
      Effect.all([
        recordSuccessfulProcessStart("human").pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "Internal", scope: "internal" },
              accountId: "333333333333",
              project: `${projectPrefix}-console`,
              environment: "prod",
            }),
          ),
        ),
        recordSuccessfulProcessStart("automated").pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              accountId: "999999999999",
              project: `${projectPrefix}-unknown`,
              environment: "dev",
            }),
          ),
        ),
      ]),
    )

    expect(metricSeries(projectPrefix)).toEqual([])
  })

  it("supports thousands of automatically included project series", async () => {
    const projectPrefix = `cardinality-${randomUUID()}-`
    const projects = Array.from(
      { length: 2_000 },
      (_, index) => `${projectPrefix}${index}`,
    )
    await Effect.runPromise(
      Effect.forEach(
        projects,
        (project) =>
          recordSuccessfulProcessStart("automated").pipe(
            Effect.provide(
              makeBusinessMetricDimensionsLayer({
                account: { name: "CustomerTwo", scope: "customer" },
                accountId: "222222222222",
                project,
                environment: indexEnvironment(project),
              }),
            ),
          ),
        { concurrency: 100 },
      ),
    )

    expect(metricSeries(projectPrefix)).toHaveLength(projects.length)
  })
})

const indexEnvironment = (project: string): string =>
  Number(project.slice(project.lastIndexOf("-") + 1)) % 2 === 0
    ? "development"
    : "production"
