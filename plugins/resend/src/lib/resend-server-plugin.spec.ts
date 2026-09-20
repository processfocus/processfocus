import { createHmac } from "node:crypto"
import { FetchHttpClient } from "@effect/platform"
import {
  type PublicCompletionDeliveryCallback,
  WebhookCallbackError,
  type WebhookCallbackHost,
  type WebhookCallbackResult,
  dispatchServerPluginWebhook,
} from "@processfocus/runtime"
import { ConfigProvider, Data, Effect, Layer } from "effect"
import {
  ResendServerPlugin,
  ResendServerPluginJobLayer,
} from "./resend-server-plugin"
import { verifyResendWebhookSignature } from "./resend-webhook-event"
import { afterEach, describe, expect, it, mock } from "bun:test"

interface ResendWebhookTodoContext {
  readonly todo: {
    readonly id: string
    readonly processExecutionId: string
    readonly processStateId: string
    readonly targetStepId: string
    readonly targetStepPath: string
    readonly createdAtMs: number
    readonly orgUnitId: string
    readonly hasForEach: boolean
    readonly barrierScheduledFlowId: string | null
  }
  readonly processState: {
    readonly state: Record<string, unknown>
  }
}

class DuplicateResendWebhookDeliveryError extends Data.TaggedError(
  "DuplicateResendWebhookDeliveryError",
)<{
  readonly deliveryId: string
}> {}

interface TestDependencies {
  readonly webhookSecret: string | undefined
  readonly pfEnvironment: string
  readonly lookupTodo: (
    todoId: string,
  ) => Effect.Effect<ResendWebhookTodoContext | null, Error>
  readonly completeTodo: (
    context: ResendWebhookTodoContext,
    deliveryId: string,
    output: { readonly emailId: string },
  ) => Effect.Effect<void, DuplicateResendWebhookDeliveryError | Error>
  readonly failTodo: (
    context: ResendWebhookTodoContext,
    failureReason: string,
    errorTag?: string,
  ) => Effect.Effect<void, Error>
  readonly applyPublicCompletionCallback?: (
    callback: PublicCompletionDeliveryCallback,
  ) => Effect.Effect<unknown, Error>
}

const applied: WebhookCallbackResult = { _tag: "Applied" }
const ignored: WebhookCallbackResult = { _tag: "Ignored" }
const mapTestError = <Result, Requirements>(
  effect: Effect.Effect<Result, Error, Requirements>,
) =>
  effect.pipe(
    Effect.mapError(
      (cause) => new WebhookCallbackError({ message: cause.message, cause }),
    ),
  )

const handleResendWebhookRequest = (
  request: Request,
  dependencies: TestDependencies,
) => {
  const callbackHost: WebhookCallbackHost["Type"] = {
    lookupDeferredTodo: (todoId: string) =>
      mapTestError(
        dependencies
          .lookupTodo(todoId)
          .pipe(
            Effect.map((context) =>
              context === null ? null : { state: context.processState.state },
            ),
          ),
      ),
    completeDeferredTodo: (input: {
      readonly todoId: string
      readonly callbackId: string
      readonly output: Record<string, unknown>
    }) =>
      mapTestError(
        Effect.gen(function* () {
          const context = yield* dependencies.lookupTodo(input.todoId)
          if (context === null) return ignored
          const emailId = input.output["emailId"]
          if (typeof emailId !== "string") return ignored
          return yield* dependencies
            .completeTodo(context, input.callbackId, { emailId })
            .pipe(
              Effect.as(applied),
              Effect.catchTag("DuplicateResendWebhookDeliveryError", () =>
                Effect.succeed(ignored),
              ),
            )
        }),
      ),
    failDeferredTodo: (input: {
      readonly todoId: string
      readonly failureReason: string
      readonly errorTag?: string
    }) =>
      mapTestError(
        Effect.gen(function* () {
          const context = yield* dependencies.lookupTodo(input.todoId)
          if (context === null) return ignored
          yield* dependencies.failTodo(
            context,
            input.failureReason,
            input.errorTag,
          )
          return applied
        }),
      ),
    applyPublicCompletionCallback: (
      callback: PublicCompletionDeliveryCallback,
    ) =>
      dependencies.applyPublicCompletionCallback
        ? mapTestError(
            dependencies
              .applyPublicCompletionCallback(callback)
              .pipe(Effect.as(applied)),
          )
        : Effect.succeed(ignored),
  }

  const config = new Map([["PF_ENV", dependencies.pfEnvironment]])
  if (dependencies.webhookSecret !== undefined) {
    config.set("RESEND_WEBHOOK_SECRET", dependencies.webhookSecret)
  }

  return dispatchServerPluginWebhook({
    request,
    registrations: [ResendServerPlugin],
    callbackHost,
  }).pipe(
    Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(config))),
  )
}

const webhookSecret = "whsec_dGVzdF9yZXNlbmRfd2ViaG9va19zZWNyZXQ="
const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0)

const signPayload = (payload: string, timestamp: string, id: string) => {
  const secretBytes = Buffer.from(webhookSecret.slice(6), "base64")
  return createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64")
}

const createSignedRequest = (payload: string, now = Date.now()) => {
  const id = "msg_test_resend_001"
  const timestamp = String(Math.floor(now / 1000))
  const signature = signPayload(payload, timestamp, id)

  return new Request("https://example.com/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  })
}

const createSignedRequestWithTimestampHeader = (
  payload: string,
  timestamp: string,
) => {
  const id = "msg_test_resend_001"
  const signature = signPayload(payload, timestamp, id)

  return new Request("https://example.com/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  })
}

const makeTodoContext = (): ResendWebhookTodoContext => ({
  todo: {
    id: "todo-123",
    processExecutionId: "pex-123",
    processStateId: "pst-123",
    targetStepId: "step-123",
    targetStepPath: "/SendEmail",
    createdAtMs: fixedNow - 30_000,
    orgUnitId: "org-unit-123",
    hasForEach: false,
    barrierScheduledFlowId: null,
  },
  processState: {
    state: {
      _internal: {
        resend: {
          emailId: "re_email_123",
          primaryTo: "primary@example.com",
          environment: "production",
        },
      },
    },
  },
})

describe("verifyResendWebhookSignature", () => {
  it("verifies the exact raw request body", () => {
    const payload =
      '{\n  "type": "email.delivered",\n  "data": {\n    "to": ["primary@example.com"]\n  }\n}'
    const request = createSignedRequest(payload, fixedNow)

    expect(
      verifyResendWebhookSignature({
        payload,
        headers: request.headers,
        webhookSecret,
        now: fixedNow,
      }),
    ).toBe(true)

    expect(
      verifyResendWebhookSignature({
        payload: JSON.stringify(JSON.parse(payload)),
        headers: request.headers,
        webhookSecret,
        now: fixedNow,
      }),
    ).toBe(false)
  })

  it("rejects expired timestamps", () => {
    const payload = '{"type":"email.delivered"}'
    const request = createSignedRequest(payload, fixedNow - 10 * 60 * 1000)

    expect(
      verifyResendWebhookSignature({
        payload,
        headers: request.headers,
        webhookSecret,
        now: fixedNow,
      }),
    ).toBe(false)
  })

  it("rejects requests missing Svix headers", () => {
    expect(
      verifyResendWebhookSignature({
        payload: '{"type":"email.delivered"}',
        headers: new Headers({ "content-type": "application/json" }),
        webhookSecret,
        now: fixedNow,
      }),
    ).toBe(false)
  })

  it("rejects non-integer timestamp values", () => {
    const payload = '{"type":"email.delivered"}'
    const request = createSignedRequestWithTimestampHeader(payload, "1.706e9")

    expect(
      verifyResendWebhookSignature({
        payload,
        headers: request.headers,
        webhookSecret,
        now: fixedNow,
      }),
    ).toBe(false)
  })
})

describe("handleResendWebhookRequest", () => {
  afterEach(() => {
    mock.restore()
  })

  it("rejects non-POST methods", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        new Request("https://example.com/webhooks/resend"),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () => Effect.succeed(null),
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(405)
  })

  it("returns 404 when the generic ingress path is not registered", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        new Request("https://example.com/webhooks/not-resend", {
          method: "POST",
        }),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () => Effect.succeed(null),
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(404)
  })

  it("returns 503 when the webhook secret is not configured", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest('{"type":"email.delivered"}'),
        {
          webhookSecret: undefined,
          pfEnvironment: "production",
          lookupTodo: () => Effect.succeed(null),
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(503)
  })

  it("rejects invalid signatures", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        new Request("https://example.com/webhooks/resend", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": "msg_bad",
            "svix-timestamp": String(Math.floor(fixedNow / 1000)),
            "svix-signature": "v1,not-a-valid-signature",
          },
          body: '{"type":"email.delivered"}',
        }),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () => Effect.succeed(null),
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(401)
  })

  it("rejects requests missing Svix headers", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        new Request("https://example.com/webhooks/resend", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: '{"type":"email.delivered"}',
        }),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () => Effect.succeed(null),
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(400)
  })

  it("returns 400 for malformed JSON with a valid signature", async () => {
    const response = await Effect.runPromise(
      handleResendWebhookRequest(createSignedRequest("not-json"), {
        webhookSecret,
        pfEnvironment: "production",
        lookupTodo: () => Effect.succeed(null),
        completeTodo: () => Effect.void,
        failTodo: () => Effect.void,
      }),
    )

    expect(response.status).toBe(400)
  })

  it("ignores webhook events for the wrong environment", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(null),
    )

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "staging",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).not.toHaveBeenCalled()
  })

  it("ignores webhook events for unknown todos", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(null),
    )
    const completeTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).toHaveBeenCalledWith("todo-123")
    expect(completeTodo).not.toHaveBeenCalled()
  })

  it("returns 500 when lookupTodo fails", async () => {
    const completeTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () => Effect.fail(new Error("lookup failed")),
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(500)
    expect(completeTodo).not.toHaveBeenCalled()
  })

  it("ignores non-delivered Resend events", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(makeTodoContext()),
    )
    const completeTodo = mock(() => Effect.void)
    const failTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.opened",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo,
          failTodo,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).not.toHaveBeenCalled()
    expect(completeTodo).not.toHaveBeenCalled()
    expect(failTodo).not.toHaveBeenCalled()
  })

  it("applies delivered public-completion callbacks", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(null),
    )
    const callbacks: PublicCompletionDeliveryCallback[] = []
    const applyPublicCompletionCallback = mock(
      (callback: PublicCompletionDeliveryCallback) =>
        Effect.sync(() => {
          callbacks.push(callback)
        }),
    )

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              email_id: "email-public-123",
              to: ["external@example.com"],
              tags: {
                pf_public_completion_todo_id: "todo-public-123",
                pf_public_completion_environment: "production",
                pf_public_completion_invitation_attempt_id: "pcia-public-123",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
          applyPublicCompletionCallback,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).not.toHaveBeenCalled()
    expect(callbacks).toEqual([
      {
        status: "delivered",
        deliveryId: "msg_test_resend_001",
        todoId: "todo-public-123",
        invitationAttemptId: "pcia-public-123",
        providerMessageId: "email-public-123",
      },
    ])
  })

  it("ignores public-completion callbacks without an environment tag", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(null),
    )
    const applyPublicCompletionCallback = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              email_id: "email-public-123",
              to: ["external@example.com"],
              tags: {
                pf_public_completion_todo_id: "todo-public-123",
                pf_public_completion_invitation_attempt_id: "pcia-public-123",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
          applyPublicCompletionCallback,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).not.toHaveBeenCalled()
    expect(applyPublicCompletionCallback).not.toHaveBeenCalled()
  })

  it("applies failed public-completion callbacks", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(null),
    )
    const callbacks: PublicCompletionDeliveryCallback[] = []
    const applyPublicCompletionCallback = mock(
      (callback: PublicCompletionDeliveryCallback) =>
        Effect.sync(() => {
          callbacks.push(callback)
        }),
    )

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.failed",
            data: {
              email_id: "email-public-123",
              to: ["external@example.com"],
              tags: {
                pf_public_completion_todo_id: "todo-public-123",
                pf_public_completion_environment: "production",
                pf_public_completion_invitation_attempt_id: "pcia-public-123",
              },
              failed: {
                recipient: "external@example.com",
                reason: "provider_timeout",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo: () => Effect.void,
          failTodo: () => Effect.void,
          applyPublicCompletionCallback,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(lookupTodo).not.toHaveBeenCalled()
    expect(callbacks).toEqual([
      {
        status: "failed",
        deliveryId: "msg_test_resend_001",
        todoId: "todo-public-123",
        invitationAttemptId: "pcia-public-123",
        providerMessageId: "email-public-123",
        failureKind: "provider_transport",
        failureReason: "Resend reported email.failed",
        failureDetails: {
          failureReasonDetail: "provider_timeout",
          recipient: "external@example.com",
        },
      },
    ])
  })

  it("fails the deferred todo for terminal Resend failure events", async () => {
    for (const eventType of [
      "email.failed",
      "email.bounced",
      "email.suppressed",
    ]) {
      const context = makeTodoContext()
      const completeTodo = mock(() => Effect.void)
      const failTodo = mock(() => Effect.void)

      const response = await Effect.runPromise(
        handleResendWebhookRequest(
          createSignedRequest(
            JSON.stringify({
              type: eventType,
              data: {
                to: ["primary@example.com"],
                tags: {
                  pf_todo_id: "todo-123",
                  pf_environment: "production",
                },
              },
            }),
          ),
          {
            webhookSecret,
            pfEnvironment: "production",
            lookupTodo: () =>
              Effect.succeed<ResendWebhookTodoContext | null>(context),
            completeTodo,
            failTodo,
          },
        ),
      )

      expect(response.status).toBe(200)
      expect(completeTodo).not.toHaveBeenCalled()
      expect(failTodo).toHaveBeenCalledWith(
        context,
        `Resend reported ${eventType}`,
        eventType,
      )
    }
  })

  it("completes the deferred todo when the primary recipient is delivered", async () => {
    const context = makeTodoContext()
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(context),
    )
    const completeTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["cc@example.com", "Primary@Example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(completeTodo).toHaveBeenCalledWith(context, "msg_test_resend_001", {
      emailId: "re_email_123",
    })
  })

  it("matches stored primary recipients case-insensitively", async () => {
    const context: ResendWebhookTodoContext = {
      ...makeTodoContext(),
      processState: {
        state: {
          _internal: {
            resend: {
              emailId: "re_email_123",
              primaryTo: "Primary@Example.com",
              environment: "production",
            },
          },
        },
      },
    }
    const completeTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () =>
            Effect.succeed<ResendWebhookTodoContext | null>(context),
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(completeTodo).toHaveBeenCalled()
  })

  it("treats duplicate delivery completions as idempotent", async () => {
    const context = makeTodoContext()
    const completeTodo = mock(() =>
      Effect.fail(
        new DuplicateResendWebhookDeliveryError({
          deliveryId: "msg_test_resend_001",
        }),
      ),
    )

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () =>
            Effect.succeed<ResendWebhookTodoContext | null>(context),
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(completeTodo).toHaveBeenCalled()
  })

  it("returns 500 when completeTodo fails with a non-duplicate error", async () => {
    const context = makeTodoContext()
    const completeTodo = mock(() => Effect.fail(new Error("write failed")))

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () =>
            Effect.succeed<ResendWebhookTodoContext | null>(context),
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(500)
  })

  it("does not complete when the webhook does not include the stored primary recipient", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(makeTodoContext()),
    )
    const completeTodo = mock(() => Effect.void)
    const failTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["cc@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo,
          failTodo,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(completeTodo).not.toHaveBeenCalled()
    expect(failTodo).not.toHaveBeenCalled()
  })

  it("does not fail when the webhook does not include the stored primary recipient", async () => {
    const lookupTodo = mock(() =>
      Effect.succeed<ResendWebhookTodoContext | null>(makeTodoContext()),
    )
    const failTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.failed",
            data: {
              to: ["cc@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo,
          completeTodo: () => Effect.void,
          failTodo,
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(failTodo).not.toHaveBeenCalled()
  })

  it("returns 503 when deferred Resend metadata is missing", async () => {
    const context: ResendWebhookTodoContext = {
      ...makeTodoContext(),
      processState: {
        state: {},
      },
    }
    const completeTodo = mock(() => Effect.void)

    const response = await Effect.runPromise(
      handleResendWebhookRequest(
        createSignedRequest(
          JSON.stringify({
            type: "email.delivered",
            data: {
              to: ["primary@example.com"],
              tags: {
                pf_todo_id: "todo-123",
                pf_environment: "production",
              },
            },
          }),
        ),
        {
          webhookSecret,
          pfEnvironment: "production",
          lookupTodo: () =>
            Effect.succeed<ResendWebhookTodoContext | null>(context),
          completeTodo,
          failTodo: () => Effect.void,
        },
      ),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("5")
    expect(completeTodo).not.toHaveBeenCalled()
  })
})

describe("ResendServerPlugin job layer", () => {
  it("resolves its default services from runtime configuration", async () => {
    const config = ConfigProvider.fromMap(
      new Map([
        ["RESEND_API_KEY", "re_test_key"],
        ["PF_ENV", "test"],
      ]),
    )

    await Effect.runPromise(
      Layer.build(ResendServerPluginJobLayer).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.setConfigProvider(config)),
      ),
    )
  })
})
