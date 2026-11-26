import { randomUUID } from "node:crypto"
import { expect } from "@playwright/test"
import { Schema } from "effect"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { dashboardAccount, dashboardRegistrationLink } from "./dashboard-user"
import { Then } from "./fixtures"
import { connectMcp } from "./mcp-todos.steps"

const listPath = "/purchase-orders"
const Order = Schema.Struct({
  id: Schema.NonEmptyString,
  item: Schema.String,
  price: Schema.Number,
})
const Browse = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      records: Schema.Struct({ items: Schema.Array(Order) }),
      sourcePage: Schema.Struct({
        page: Schema.Int,
        filter: Schema.optionalKey(Schema.String),
      }),
    }),
  }),
})
const Describe = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      actions: Schema.Struct({
        relatedProcessStarts: Schema.Struct({
          permitted: Schema.Array(
            Schema.Struct({ name: Schema.String, path: Schema.String }),
          ),
        }),
      }),
    }),
  }),
})

Then(
  "a view-only MCP client can filter and inspect the matching Purchase Orders",
  async ({ page, baseURL, scenarioState }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const filter = scenarioState.get("matchingOrderPrefix")
    if (typeof filter !== "string") throw new Error("Missing order fixture")
    const call = await connectMcp({
      page,
      baseURL,
      choice: "View work",
    })
    expect(await call("list_lists")).toMatchObject({
      result: {
        structuredContent: {
          lists: expect.arrayContaining([
            expect.objectContaining({
              path: listPath,
              name: "Purchase Orders",
            }),
          ]),
        },
      },
    })
    const browse = () => call("browse_list", { listPath, filter })
    await expect.poll(browse, { timeout: 30_000 }).toMatchObject({
      result: {
        structuredContent: { records: { totalCount: 2, hasNextPage: false } },
      },
    })
    const { items } = Schema.decodeUnknownSync(Browse)(await browse()).result
      .structuredContent.records
    expect(items.map(({ item }) => item).sort()).toEqual([
      `${filter} Chair`,
      `${filter} Desk`,
    ])
    expect(new Set(items.map(({ id }) => id)).size).toBe(2)
    expect(
      await call("browse_list", { listPath, filter: `${filter} absent` }),
    ).toMatchObject({
      result: { structuredContent: { records: { items: [], totalCount: 0 } } },
    })
    const selected = items.find(({ item }) => item.endsWith("Chair"))
    if (!selected) throw new Error("Missing matching Chair")
    expect(
      await call("inspect_list_record", { listPath, id: selected.id }),
    ).toHaveProperty("result.structuredContent.record", selected)
    scenarioState.set("mcpOrder", selected)
    expect(await call("describe_list", { listPath })).toMatchObject({
      result: {
        structuredContent: {
          actions: {
            createRecord: {
              configured: false,
              runtimeAuthorized: false,
              permitted: false,
            },
            updateRecord: {
              configured: true,
              runtimeAuthorized: true,
              permitted: false,
            },
            relatedProcessStarts: {
              configuredCount: 1,
              runtimeAuthorized: [
                { name: "Purchase Request", startStepPath: expect.any(String) },
              ],
              permitted: [],
            },
          },
        },
      },
    })
    expect(
      await call("start_process", {
        processPath: "/finance/purchase-request",
        listContext: { listPath, recordId: selected.id },
        input: { item: `${filter} Follow-up`, value: "25" },
        executionId: `pex-${randomUUID()}`,
        confirmed: true,
      }),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "A View and act grant is required." }],
      },
    })
  },
)

Then(
  "the Purchase Request starts once through MCP with its selected order in the form context",
  async ({ page, baseURL, scenarioState }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const call = await connectMcp({
      page,
      baseURL,
      choice: "View and act",
    })
    const description = await call("describe_list", { listPath })
    expect(description).toMatchObject({
      result: {
        structuredContent: {
          actions: {
            updateRecord: {
              configured: true,
              runtimeAuthorized: true,
              permitted: true,
            },
            relatedProcessStarts: {
              permitted: [
                {
                  name: "Purchase Request",
                  path: "/finance/purchase-request",
                  startStepPath: expect.any(String),
                },
              ],
            },
          },
        },
      },
    })
    const { permitted } =
      Schema.decodeUnknownSync(Describe)(description).result.structuredContent
        .actions.relatedProcessStarts
    const action = permitted.find(({ name }) => name === "Purchase Request")
    if (!action) throw new Error("Expected the configured Purchase Request")
    const record = Schema.decodeUnknownSync(Order)(
      scenarioState.get("mcpOrder"),
    )
    const processPath = action.path
    expect(
      await call("get_process_start_form", {
        processPath,
        listContext: { listPath },
      }),
    ).toMatchObject({
      result: {
        structuredContent: {
          listContext: { listPath, listName: "Purchase Orders" },
          dashboardUrl: expect.stringContaining(
            "returnTo=%2Flists%2Fpurchase-orders",
          ),
        },
      },
    })
    const listContext = { listPath, recordId: record.id }
    const formArgs = { processPath, listContext }
    const form = await call("get_process_start_form", formArgs)
    expect(form).toMatchObject({
      result: {
        structuredContent: {
          listContext: {
            ...listContext,
            listName: "Purchase Orders",
            record,
          },
          fields: expect.arrayContaining([
            expect.objectContaining({
              path: ["item"],
              label: "Item",
            }),
          ]),
        },
      },
    })
    const executionId = `pex-${randomUUID()}`
    const submission = {
      ...formArgs,
      input: { item: `${record.item} Follow-up`, value: "25" },
      executionId,
    }
    const executions = () => call("list_executions", { processPath })
    const before = await executions()
    expect(before).toMatchObject({
      result: {
        structuredContent: { hasNextPage: false, nodes: expect.any(Array) },
      },
    })
    const handoff = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          structuredContent: Schema.Struct({
            status: Schema.Literal("dashboard_required"),
            dashboardUrl: Schema.String,
          }),
        }),
      }),
    )(
      await call("start_process", {
        ...submission,
        input: { ...submission.input, referenceOrderId: record.id },
        confirmed: true,
      }),
    ).result.structuredContent
    await page.goto(handoff.dashboardUrl)
    await expect(
      page.getByRole("dialog", { name: "Purchase Request" }),
    ).toHaveAccessibleDescription(
      `Start a process for List record ${record.id}`,
    )

    // An unresolved choice has not authorized a write. A stale record also
    // cannot be used to start this otherwise-authorized Process.
    expect(await call("start_process", submission)).toMatchObject({
      result: { isError: true },
    })
    for (const unavailableContext of [
      { listPath, recordId: `absent-${randomUUID()}` },
      { listPath: "/process-catalog-browsing" },
    ]) {
      expect(
        await call("start_process", {
          ...submission,
          listContext: unavailableContext,
          confirmed: true,
        }),
      ).toMatchObject({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "The related Process or List record is not available.",
            },
          ],
        },
      })
    }
    const executionUrl = `${baseURL}/executions/${executionId}`
    expect(
      await call("start_process", { ...submission, confirmed: true }),
    ).toMatchObject({
      result: {
        structuredContent: { status: "started", executionId, executionUrl },
      },
    })
    expect(
      await call("recover_process_start", {
        ...submission,
        listContext: { listPath },
      }),
    ).toMatchObject({
      result: { structuredContent: { status: "unknown" } },
    })
    const ExecutionList = Schema.Struct({
      result: Schema.Struct({
        structuredContent: Schema.Struct({
          hasNextPage: Schema.Literal(false),
          nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
        }),
      }),
    })
    const ids = (value: unknown) =>
      Schema.decodeUnknownSync(ExecutionList)(value)
        .result.structuredContent.nodes.map(({ id }) => id)
        .sort()
    await expect
      .poll(async () => ids(await executions()))
      .toEqual([...ids(before), executionId].sort())
    scenarioState.set("mcpRelatedStart", submission)
    console.info(`Started Purchase Request ${executionId}: ${executionUrl}`)
  },
)

Then(
  "a selected row on {string} can start a Purchase Request through MCP without detail access",
  async ({ page, baseURL, scenarioState }, variant: string) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const listPath = `/purchase-orders-${variant}`
    const filter = Schema.decodeUnknownSync(Schema.String)(
      scenarioState.get("matchingOrderPrefix"),
    )
    const call = await connectMcp({ page, baseURL, choice: "View and act" })
    const description = await call("describe_list", { listPath })
    expect(description).toHaveProperty(
      "result.structuredContent.actions.inspect",
      {
        configured: variant === "restricted-detail",
        permitted: false,
      },
    )
    const [action] =
      Schema.decodeUnknownSync(Describe)(description).result.structuredContent
        .actions.relatedProcessStarts.permitted
    if (!action) throw new Error("Expected a related Process")
    const { sourcePage, records } = Schema.decodeUnknownSync(Browse)(
      await call("browse_list", { listPath, page: 2, filter }),
    ).result.structuredContent
    expect(sourcePage).toEqual({ page: 2, filter })
    const [record] = records.items
    if (!record) throw new Error("Expected a browsed Purchase Order")
    const listContext = { listPath, recordId: record.id, sourcePage }
    const args = { processPath: action.path, listContext }
    expect(await call("get_process_start_form", args)).toMatchObject({
      result: {
        structuredContent: {
          listContext: { ...listContext, record },
        },
      },
    })
    const executionId = `pex-${randomUUID()}`
    const submission = {
      ...args,
      input: { item: `${record.item} ${variant} Follow-up`, value: "25" },
      executionId,
      confirmed: true,
    }
    expect(
      await call("start_process", {
        ...submission,
        listContext: { ...listContext, sourcePage: { ...sourcePage, page: 1 } },
      }),
    ).toHaveProperty("result.isError", true)
    expect(await call("start_process", submission)).toMatchObject({
      result: {
        structuredContent: {
          status: "started",
          executionId,
          executionUrl: `${baseURL}/executions/${executionId}`,
        },
      },
    })
    await expect
      .poll(() => call("get_execution", { id: executionId }))
      .toHaveProperty("result.structuredContent.id", executionId)
    console.info(
      `Started ${variant} Purchase Request ${executionId}: ${baseURL}/executions/${executionId}`,
    )
  },
)

Then(
  "an MCP client without List access cannot discover or inspect those orders",
  async ({ baseURL, passkeyUser, scenarioState }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const { id } = Schema.decodeUnknownSync(Order)(
      scenarioState.get("mcpOrder"),
    )
    const { account, save } = dashboardAccount(
      baseURL,
      "finance-manager@example.com",
    )
    const { page } = await passkeyUser({
      baseURL,
      graphqlEndpoint: getEffectiveGraphqlEndpoint(),
      account,
      saveCredentials: save,
      invite: dashboardRegistrationLink,
      provisionOnly: true,
    })
    const call = await connectMcp({
      page,
      baseURL,
      choice: "View and act",
    })
    expect(await call("list_lists")).toMatchObject({
      result: { structuredContent: { lists: [] } },
    })
    const denied = await call("inspect_list_record", { listPath, id })
    expect(denied).toMatchObject({ result: { isError: true } })
    expect(denied).not.toHaveProperty("result.structuredContent")
    expect(await call("browse_list", { listPath })).toMatchObject({
      result: { isError: true },
    })
    expect(await call("describe_list", { listPath })).toMatchObject({
      result: { isError: true },
    })
    expect(
      await call("start_process", {
        ...Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Unknown),
        )(scenarioState.get("mcpRelatedStart")),
        executionId: `pex-${randomUUID()}`,
        confirmed: true,
      }),
    ).toMatchObject({ result: { isError: true } })
  },
)
