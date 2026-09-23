import { join } from "node:path"
import { Schema } from "effect"
import { describe, expect, it } from "bun:test"

const dashboardPath = join(
  import.meta.dir,
  "../grafana/dashboards/customer-process-starts.json",
)

const DashboardContract = Schema.Struct({
  timezone: Schema.String,
  time: Schema.Struct({
    from: Schema.String,
    to: Schema.String,
  }),
  panels: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      targets: Schema.Array(
        Schema.Struct({
          expr: Schema.String,
          interval: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

const readDashboard = async () => {
  const contents = await Bun.file(dashboardPath).text()
  return {
    contents,
    contract: await Schema.decodeUnknownPromise(
      Schema.parseJson(DashboardContract),
    )(contents),
  }
}

describe("customer process-start dashboard", () => {
  it("aligns the 30 daily query evaluations to UTC day boundaries", async () => {
    const { contract } = await readDashboard()

    expect(contract.timezone).toBe("utc")
    expect(contract.time).toEqual({
      from: "now-29d/d",
      to: "now+1d/d",
    })

    const dailyPanel = contract.panels.find(
      (panel) => panel.title === "Daily process starts (UTC)",
    )
    expect(dailyPanel).toBeDefined()
    expect(dailyPanel?.targets).toEqual([
      expect.objectContaining({
        expr: expect.stringContaining("[1d]"),
        interval: "1d",
      }),
    ])
  })

  it("is reproducible and uses scalable customer-scope queries", async () => {
    const { contents: dashboard } = await readDashboard()

    expect(dashboard).toContain('"refresh": "5m"')
    expect(dashboard).toContain("pf_business_process_starts_total")
    expect(dashboard).toContain('pf_account_scope=\\"customer\\"')
    expect(dashboard).toContain("[1d]")
    expect(dashboard).toContain("$account")
    expect(dashboard).toContain("$project")
    expect(dashboard).toContain("$environment")
    expect(dashboard.match(/"title": "Project breakdown"/g)).toHaveLength(1)
    expect(dashboard).not.toContain("2781-7720-6987")
    expect(dashboard).not.toContain("6568-4457-6184")
  })

  it("includes the Loki-backed distinct daily-active-user panel", async () => {
    const { contract, contents } = await readDashboard()
    const dauPanel = contract.panels.find(
      (panel) => panel.title === "Daily active users (UTC)",
    )

    expect(dauPanel).toBeDefined()
    expect(dauPanel?.targets[0]?.expr).toContain(
      'service_name="pf-dashboard-activity"',
    )
    expect(dauPanel?.targets[0]?.expr).toContain("sum by (day, identity)")
    expect(dauPanel?.targets[0]?.expr).toContain("count by (day)")
    expect(contents).toContain('"name": "logsDatasource"')
    expect(contents).toContain('"type": "loki"')
  })
})

it("deployment panels share UTC buckets and include targets without process starts", async () => {
  const { contract, contents } = await readDashboard()
  const daily = contract.panels.find(
    (panel) => panel.title === "Daily deployment outcomes (UTC)",
  )
  expect(daily?.targets[0]?.expr).toContain("sum by (pf_outcome)")
  expect(daily?.targets[0]?.interval).toBe("1d")
  const breakdown = contract.panels.find(
    (panel) => panel.title === "Deployment project breakdown",
  )
  expect(breakdown?.targets[0]?.expr).toContain("[1d])[$__range:1d]")
  expect(contents).toContain(
    "pf_business_(process_starts|step_completions|deployment_attempts|external_actions)_total",
  )
})

it("keeps external action counts separate with shared scope filters and daily UTC queries", async () => {
  const { contract, contents } = await readDashboard()
  const externalPanels = contract.panels.filter((panel) =>
    ["Daily external actions (UTC)", "External actions by project"].includes(
      panel.title,
    ),
  )
  expect(externalPanels).toHaveLength(2)
  for (const panel of externalPanels) {
    const query = panel.targets[0]?.expr
    expect(query).toContain("pf_business_external_actions_total")
    expect(query).toContain('pf_account_scope="customer"')
    expect(query).toContain('pf_account_name=~"$account"')
    expect(query).toContain('pf_project=~"$project"')
    expect(query).toContain('pf_environment=~"$environment"')
    expect(query).toContain("pf_action")
    expect(query).not.toContain("identity")
    expect(query).not.toContain("pf_trigger")
  }
  expect(externalPanels[0]?.targets[0]?.interval).toBe("1d")
  expect(externalPanels[0]?.targets[0]?.expr).toContain("[1d]")
  expect(contents).toContain("deployment_attempts|external_actions)_total")
  expect(contents).toContain("these panels are not additive")
})
