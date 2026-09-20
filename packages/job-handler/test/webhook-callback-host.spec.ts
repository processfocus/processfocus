import { SqlClient } from "@effect/sql"
import {
  QueueService,
  SERVER_PLUGIN_HOST_INTERFACE_VERSION,
  WebhookCallbackHost,
} from "@processfocus/runtime"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import {
  BusinessCalendarQueries,
  FlowExecutionOperations,
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
} from "@pf/graphql-db-operations"
import { Organisation, OrganisationProvider } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { makeServerPluginWebhookRouter } from "../src/handlers/webhook-callback-host"
import { describe, expect, it } from "bun:test"

const webhookPath = "/webhooks/test"

const TestLayer = Layer.mergeAll(
  Layer.mock(StepCompletionOperations, {
    queryTodoById: () => Effect.succeed(null),
  }),
  Layer.mock(ScheduledFlowOperations, {}),
  Layer.mock(FlowExecutionOperations, {}),
  Layer.mock(BusinessCalendarQueries, {}),
  Layer.mock(QueueService, {}),
  Layer.mock(SqlClient.SqlClient, {}),
  Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake("2026-09-02T00:00:00Z")),
  ),
  Layer.succeed(UserDetails, FiberRef.unsafeMake({ by: "SYSTEM", id: null })),
  Layer.succeed(OrganisationProvider, {
    organisation: new Organisation({ name: "Webhook test" }),
    orgPath: "/tmp/webhook-test",
    schemaPath: "/tmp/webhook-test/org.graphql",
    serverPlugins: [
      {
        identity: "test.webhook",
        hostInterfaceVersion: SERVER_PLUGIN_HOST_INTERFACE_VERSION,
        webhooks: [
          {
            path: webhookPath,
            handle: () =>
              Effect.gen(function* () {
                const callbackHost = yield* WebhookCallbackHost
                const outcome = yield* callbackHost.completeDeferredTodo({
                  todoId: "missing-todo",
                  callbackId: "callback-1",
                  output: {},
                })
                return Response.json(outcome)
              }),
          },
        ],
      },
    ],
  }),
)

describe("makeServerPluginWebhookRouter", () => {
  it("routes an HTTP request through organisation plugins and the real callback host", async () => {
    const routeWebhook = await Effect.runPromise(
      makeServerPluginWebhookRouter.pipe(Effect.provide(TestLayer)),
    )
    const responseEffect = routeWebhook(
      new Request(`https://example.com${webhookPath}`, { method: "POST" }),
    )

    expect(responseEffect).toBeDefined()
    if (responseEffect === undefined) return

    const response = await Effect.runPromise(responseEffect)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: "Ignored" })
  })

  it("leaves non-webhook requests outside the Effect runtime", async () => {
    const routeWebhook = await Effect.runPromise(
      makeServerPluginWebhookRouter.pipe(Effect.provide(TestLayer)),
    )
    const responseEffect = routeWebhook(
      new Request("https://example.com/graphql"),
    )

    expect(responseEffect).toBeUndefined()
  })
})
