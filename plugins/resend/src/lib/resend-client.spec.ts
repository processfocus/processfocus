import { createHmac } from "node:crypto"
import { FetchHttpClient } from "@effect/platform"
import { makeMockResendPlugin } from "@processfocus/plugin-resend/test-support"
import { Cause, ConfigProvider, Effect, Layer } from "effect"
import { EmailSender, NotificationDeliveryConfig } from "@pf/job-handler"
import {
  ResendClient,
  ResendClientConfigFromEnv,
  ResendClientLive,
} from "./resend-client"
import { afterEach, describe, expect, it } from "bun:test"

describe("ResendClientLive", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("sends the email message to the Resend API", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        idempotencyKey: "notification-delivery-001",
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "New task assigned: Purchase approval / Finish purchase",
        html: "<p>Hello</p>",
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "true"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()
    expect(capturedRequest?.url).toBe("https://api.resend.com/emails")
    expect(capturedRequest?.method).toBe("POST")
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer re_test")
    expect(capturedRequest?.headers.get("idempotency-key")).toBe(
      "notification-delivery-001",
    )

    const body = JSON.parse(await capturedRequest!.text()) as {
      to: string
      from: string
      subject: string
      html: string
      headers?: Record<string, string>
    }

    expect(body).toEqual({
      to: "person@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "New task assigned: Purchase approval / Finish purchase",
      html: "<p>Hello</p>",
    })
  })

  it("marks rerouted emails in the subject and headers", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_456" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: ["first@example.com", "second@example.com"],
        from: "Process Focus <notifications@example.com>",
        subject: "New task assigned: Purchase approval / Finish purchase",
        html: "<p>Hello</p>",
        headers: {
          "Reply-Category": "workflow",
        },
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        tags: [{ name: "pf_todo_id", value: "todo-123" }],
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "false"],
              ["RESEND_REROUTE_EMAIL", "reroute@example.com"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()

    const body = JSON.parse(await capturedRequest!.text()) as {
      to: string
      from: string
      subject: string
      html: string
      cc?: string
      bcc?: string
      headers: Record<string, string>
      tags?: readonly { readonly name: string; readonly value: string }[]
    }

    expect(body).toEqual({
      to: "reroute@example.com",
      from: "Process Focus <notifications@example.com>",
      subject:
        "[REROUTED] New task assigned: Purchase approval / Finish purchase",
      html: "<p>Hello</p>",
      headers: {
        "Reply-Category": "workflow",
        "ProcessFocus-Rerouted": "true",
        "ProcessFocus-Original-To": "first@example.com, second@example.com",
        "ProcessFocus-Rerouted-To": "reroute@example.com",
        "ProcessFocus-Reroute-Reason": "resend_disabled",
      },
      tags: [{ name: "pf_todo_id", value: "todo-123" }],
    })
    expect(body.cc).toBeUndefined()
    expect(body.bcc).toBeUndefined()
    expect(body.headers["ProcessFocus-Env"]).toBeUndefined()
  })

  it("adds the PF environment header when PF_ENV is set", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_env" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Environment header",
        html: "<p>Hello</p>",
        headers: { "X-Custom": "value" },
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "true"],
              ["PF_ENV", "ci"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()

    const body = JSON.parse(await capturedRequest!.text()) as {
      headers: Record<string, string>
    }

    expect(body.headers).toEqual({
      "X-Custom": "value",
      "ProcessFocus-Env": "ci",
    })
  })

  it("keeps the PF environment header when rerouting emails", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_env_rerouted" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Environment header",
        html: "<p>Hello</p>",
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "false"],
              ["RESEND_REROUTE_EMAIL", "reroute@example.com"],
              ["PF_ENV", "ci"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()

    const body = JSON.parse(await capturedRequest!.text()) as {
      headers: Record<string, string>
    }

    expect(body.headers).toEqual({
      "ProcessFocus-Env": "ci",
      "ProcessFocus-Rerouted": "true",
      "ProcessFocus-Original-To": "person@example.com",
      "ProcessFocus-Rerouted-To": "reroute@example.com",
      "ProcessFocus-Reroute-Reason": "resend_disabled",
    })
  })

  it("does not reroute when Resend is enabled and reroute email is configured", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_enabled" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Enabled send",
        html: "<p>Hello</p>",
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "true"],
              ["RESEND_REROUTE_EMAIL", "reroute@example.com"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()

    const body = JSON.parse(await capturedRequest!.text()) as {
      to: string
      subject: string
      headers?: Record<string, string>
    }

    expect(body.to).toBe("person@example.com")
    expect(body.subject).toBe("Enabled send")
    expect(body.headers?.["ProcessFocus-Rerouted"]).toBeUndefined()
  })

  it("does not reroute when sending directly to the reroute email", async () => {
    let capturedRequest: Request | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)

      return new Response(JSON.stringify({ id: "email_789" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: "reroute@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Direct reroute inbox message",
        html: "<p>Hello</p>",
      })
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "false"],
              ["RESEND_REROUTE_EMAIL", "reroute@example.com"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(capturedRequest).toBeDefined()

    const body = JSON.parse(await capturedRequest!.text()) as {
      to: string
      subject: string
      headers?: Record<string, string>
    }

    expect(body.to).toBe("reroute@example.com")
    expect(body.subject).toBe("Direct reroute inbox message")
    expect(body.headers).toBeUndefined()
  })

  it("dies when resend is disabled without a reroute email", async () => {
    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      yield* resendClient.sendEmail({
        to: "person@example.com",
        subject: "Subject",
      })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
            FetchHttpClient.layer,
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["RESEND_API_KEY", "re_test"],
              ["RESEND_ENABLED", "false"],
            ]),
          ),
        ),
      ) as Effect.Effect<void>,
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("Expected resend call to fail")
    }

    const defects = Array.from(Cause.defects(exit.cause))
    expect(defects).toHaveLength(1)
    expect(defects[0]).toMatchObject({
      _tag: "ResendError",
      message: "RESEND_REROUTE_EMAIL must be set when RESEND_ENABLED is false",
    })
  })
})

describe("makeMockResendPlugin", () => {
  // Keep this separate from the mock's private helper so the signature test
  // verifies the HMAC input independently.
  const getSecretBytes = (secret: string): Buffer => {
    const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret
    return Buffer.from(encodedSecret, "base64")
  }

  it("captures ResendClient sends and emits signed Resend-style events", async () => {
    const mock = makeMockResendPlugin({
      deliveryIdPrefix: "evt_test",
      emailIdPrefix: "email_test",
      environment: "dev",
    })

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "External review",
        template: {
          id: "public-completion-template",
          variables: {
            PUBLIC_URL: "https://console.example.com/public/todo/token",
          },
        },
        tags: [{ name: "pf_todo_id", value: "todo-123" }],
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(mock.layer)),
    )

    expect(result).toEqual({
      emailId: "email_test_000001",
      sentTo: "person@example.com",
    })

    const messages = mock.controller.listSentMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.request.template).toEqual({
      id: "public-completion-template",
      variables: {
        PUBLIC_URL: "https://console.example.com/public/todo/token",
      },
    })
    expect(messages[0]?.request.tags).toEqual([
      { name: "pf_todo_id", value: "todo-123" },
    ])
    expect(mock.controller.findMessageByEmailId(result.emailId)?.emailId).toBe(
      result.emailId,
    )
    expect(mock.controller.findMessageByTodoId("todo-123")?.emailId).toBe(
      result.emailId,
    )

    const delivered = mock.controller.emitDelivery(result.emailId, {
      deliveryId: "evt-delivered-001",
      eventCreatedAt: "2026-06-01T00:00:00.000Z",
      timestampSeconds: 1_800_000_000,
    })
    expect(delivered.request.method).toBe("POST")
    expect(delivered.headers.get("svix-id")).toBe("evt-delivered-001")
    const expectedSignature = createHmac(
      "sha256",
      getSecretBytes(mock.controller.webhookSecret),
    )
      .update(`evt-delivered-001.1800000000.${delivered.body}`)
      .digest("base64")
    expect(delivered.headers.get("svix-signature")).toBe(
      `v1,${expectedSignature}`,
    )
    expect(delivered.webhookSecret).toBe(mock.controller.webhookSecret)
    expect(JSON.parse(delivered.body)).toEqual({
      type: "email.delivered",
      created_at: "2026-06-01T00:00:00.000Z",
      data: {
        created_at: expect.any(String),
        email_id: result.emailId,
        from: "Process Focus <notifications@example.com>",
        subject: "External review",
        to: ["person@example.com"],
        tags: { pf_todo_id: "todo-123" },
      },
    })

    expect(
      JSON.parse(mock.controller.emitBounce(result.emailId).body),
    ).toMatchObject({
      type: "email.bounced",
      data: { bounce: { type: "hard" } },
    })
    expect(
      JSON.parse(mock.controller.emitSuppression(result.emailId).body),
    ).toMatchObject({
      type: "email.suppressed",
      data: { suppressed: { recipient: "person@example.com" } },
    })
    expect(
      JSON.parse(mock.controller.emitRecipientFailure(result.emailId).body),
    ).toMatchObject({
      type: "email.failed",
      data: {
        failed: {
          recipient: "person@example.com",
          reason: "recipient_not_found",
        },
      },
    })
  })

  it("provides notification email services and public completion lookup helpers", async () => {
    const mock = makeMockResendPlugin({
      environment: "dev",
      frontendBaseUrl: "https://console.example.com",
      sender: {
        email: "notifications@example.com",
        name: "Process Focus",
      },
    })

    const program = Effect.gen(function* () {
      const config = yield* NotificationDeliveryConfig
      const emailSender = yield* EmailSender

      expect(config.getFrontendBaseUrl()).toBe("https://console.example.com")
      expect(config.getEnvironment()).toBe("dev")
      expect(config.getSenderIdentity()).toEqual({
        email: "notifications@example.com",
        name: "Process Focus",
      })

      return yield* emailSender.send({
        to: "external@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Complete form: Purchase approval / External review",
        html: "<p>Please complete the external review.</p>",
        tags: [
          { name: "pf_public_completion_todo_id", value: "todo-public-123" },
          { name: "pf_public_completion_environment", value: "dev" },
          {
            name: "pf_public_completion_invitation_attempt_id",
            value: "pcia-123",
          },
        ],
      })
    })

    const receipt = await Effect.runPromise(
      program.pipe(Effect.provide(mock.layer)),
    )

    expect(receipt).toEqual({
      providerMessageId: "email_mock_000001",
      providerSentTo: "external@example.com",
    })

    expect(
      mock.controller.findMessageByEmailId("email_mock_000001")?.request,
    ).toEqual({
      to: "external@example.com",
      from: "Process Focus <notifications@example.com>",
      subject: "Complete form: Purchase approval / External review",
      html: "<p>Please complete the external review.</p>",
      headers: { "ProcessFocus-Env": "dev" },
      tags: [
        { name: "pf_public_completion_todo_id", value: "todo-public-123" },
        { name: "pf_public_completion_environment", value: "dev" },
        {
          name: "pf_public_completion_invitation_attempt_id",
          value: "pcia-123",
        },
      ],
    })

    const publicCompletionMessage =
      mock.controller.findMessageByPublicCompletionInvitationAttemptId(
        "pcia-123",
      )
    expect(publicCompletionMessage?.emailId).toBe("email_mock_000001")
    expect(publicCompletionMessage?.request.tags).toEqual([
      { name: "pf_public_completion_todo_id", value: "todo-public-123" },
      { name: "pf_public_completion_environment", value: "dev" },
      {
        name: "pf_public_completion_invitation_attempt_id",
        value: "pcia-123",
      },
    ])
  })

  it("captures reroute-relevant behavior when mock Resend is disabled", async () => {
    const mock = makeMockResendPlugin({
      enabled: false,
      rerouteEmail: "reroute@example.com",
    })

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: ["first@example.com", "second@example.com"],
        from: "Process Focus <notifications@example.com>",
        subject: "Needs reroute",
        html: "<p>Hello</p>",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(mock.layer)),
    )

    expect(result.sentTo).toBe("reroute@example.com")

    const message = mock.controller.findMessageByEmailId(result.emailId)
    expect(message?.rerouted).toBe(true)
    expect(message?.originalTo).toEqual([
      "first@example.com",
      "second@example.com",
    ])
    expect(message?.request).toMatchObject({
      to: "reroute@example.com",
      subject: "[REROUTED] Needs reroute",
      headers: {
        "ProcessFocus-Rerouted": "true",
        "ProcessFocus-Original-To": "first@example.com, second@example.com",
        "ProcessFocus-Rerouted-To": "reroute@example.com",
        "ProcessFocus-Reroute-Reason": "resend_disabled",
      },
    })
    expect(message?.request.cc).toBeUndefined()
    expect(message?.request.bcc).toBeUndefined()
  })

  it("fails mock sends when disabled without a reroute email", async () => {
    const mock = makeMockResendPlugin({ enabled: false })

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Missing reroute",
        html: "<p>Hello</p>",
      })
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(mock.layer)),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") {
      throw new Error("Expected mock resend call to fail")
    }

    const defects = Array.from(Cause.defects(exit.cause))
    expect(defects).toHaveLength(1)
    expect(defects[0]).toMatchObject({
      _tag: "ResendError",
      message: "RESEND_REROUTE_EMAIL must be set when RESEND_ENABLED is false",
    })
  })

  it("supports null sender identity for notification config", async () => {
    const mock = makeMockResendPlugin({ sender: null })

    const senderIdentity = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* NotificationDeliveryConfig
        return config.getSenderIdentity()
      }).pipe(Effect.provide(mock.layer)),
    )

    expect(senderIdentity).toBeUndefined()
  })

  it("resets captured messages and sequences when cleared", async () => {
    const mock = makeMockResendPlugin()

    const send = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Clear sequence",
        html: "<p>Hello</p>",
      })
    })

    const first = await Effect.runPromise(send.pipe(Effect.provide(mock.layer)))
    const firstDelivery = mock.controller.emitDelivery(first.emailId)

    mock.controller.clear()

    const second = await Effect.runPromise(
      send.pipe(Effect.provide(mock.layer)),
    )
    const secondDelivery = mock.controller.emitDelivery(second.emailId)

    expect(first.emailId).toBe("email_mock_000001")
    expect(second.emailId).toBe("email_mock_000001")
    expect(firstDelivery.headers.get("svix-id")).toBe("msg_mock_000001")
    expect(secondDelivery.headers.get("svix-id")).toBe("msg_mock_000001")
    expect(mock.controller.listSentMessages()).toHaveLength(1)
  })

  it("uses injected now for captured and callback timestamps", async () => {
    const now = new Date("2024-01-02T03:04:05.000Z")
    const mock = makeMockResendPlugin({ now: () => now })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resendClient = yield* ResendClient

        return yield* resendClient.sendEmail({
          to: "person@example.com",
          from: "Process Focus <notifications@example.com>",
          subject: "Clock",
          html: "<p>Hello</p>",
        })
      }).pipe(Effect.provide(mock.layer)),
    )

    const message = mock.controller.findMessageByEmailId(result.emailId)
    const delivered = mock.controller.emitDelivery(result.emailId)

    expect(message?.createdAt).toBe("2024-01-02T03:04:05.000Z")
    expect(delivered.payload.created_at).toBe("2024-01-02T03:04:05.000Z")
    expect(delivered.payload.data.created_at).toBe("2024-01-02T03:04:05.000Z")
    expect(delivered.headers.get("svix-timestamp")).toBe(
      String(Math.floor(now.getTime() / 1000)),
    )
  })

  it("rejects sends without recipients", async () => {
    const mock = makeMockResendPlugin()

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: [],
        from: "Process Focus <notifications@example.com>",
        subject: "No recipients",
        html: "<p>Hello</p>",
      })
    })

    const error = await Effect.runPromise(
      program.pipe(Effect.provide(mock.layer), Effect.flip),
    )

    expect(error).toMatchObject({
      _tag: "ResendError",
      message: "Mock Resend requires at least one recipient",
    })
  })

  it("rejects event helpers for object refs from another controller", async () => {
    const firstMock = makeMockResendPlugin({ emailIdPrefix: "email_first" })
    const secondMock = makeMockResendPlugin({ emailIdPrefix: "email_second" })

    const program = Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return yield* resendClient.sendEmail({
        to: "person@example.com",
        from: "Process Focus <notifications@example.com>",
        subject: "Other controller",
        html: "<p>Hello</p>",
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(firstMock.layer)),
    )
    const message = firstMock.controller.findMessageByEmailId(result.emailId)

    expect(message).toBeDefined()
    if (message === undefined) {
      return
    }

    expect(() => secondMock.controller.emitDelivery(message)).toThrow(
      "Mock Resend message not found: email_first_000001",
    )
  })
})
