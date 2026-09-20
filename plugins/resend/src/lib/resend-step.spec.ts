import { FetchHttpClient } from "@effect/platform"
import { makeMockResendPlugin } from "@processfocus/plugin-resend/test-support"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect"
import {
  OrgUnit,
  Organisation,
  Process,
  StepProcessStateReader,
} from "@pf/process"
import {
  ResendClientConfigFromEnv,
  ResendClientLive,
  ResendDeferredDelivery,
} from "./resend-client"
import { ResendStep } from "./resend-step"
import { afterEach, describe, expect, it } from "bun:test"

type DeferredStepResult = {
  readonly _tag: "Deferred"
  readonly stateUpdate?: Readonly<Record<string, unknown>>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isDeferredStepResult = (value: unknown): value is DeferredStepResult =>
  isRecord(value) && value["_tag"] === "Deferred"

describe("ResendStep", () => {
  const org = new Organisation({ name: "TestOrg" })
  const unit = new OrgUnit(org, "test-unit", { name: "Test Unit" })

  it("should construct with from property", () => {
    const process = new Process(unit, "TestProcess", {
      name: "Test Process",
      purpose: "Testing ResendStep",
    })

    const step = new ResendStep(process, "SendEmail", {
      from: "Process Focus <noreply@processfocus.com>",
      input: () =>
        Effect.succeed({
          to: "test@example.com",
          subject: "Test email",
        }),
    })

    expect(step.from).toBe("Process Focus <noreply@processfocus.com>")
    expect(step.isSystemStep).toBe(true)
  })

  it("should have isSystemStep === true", () => {
    const process = new Process(unit, "TestProcess2", {
      name: "Test Process 2",
      purpose: "Testing",
    })

    const step = new ResendStep(process, "TestStep", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Hello",
        }),
    })

    expect(step.isSystemStep).toBe(true)
  })

  it("should extend SystemStep", () => {
    const process = new Process(unit, "TestProcess3", {
      name: "Test Process 3",
      purpose: "Testing",
    })

    const step = new ResendStep(process, "SystemTest", {
      from: "System <system@example.com>",
      input: () =>
        Effect.succeed({
          to: "recipient@example.com",
          subject: "Test",
        }),
    })

    // Verify it has the SystemStep interface
    expect(typeof step.executeWithInput).toBe("function")
    expect(typeof step.execute).toBe("function")
    expect(typeof step.input).toBe("function")
  })

  it("should have fixed output schema with emailId", () => {
    const process = new Process(unit, "TestProcess4", {
      name: "Test Process 4",
      purpose: "Testing output schema",
    })

    const step = new ResendStep(process, "OutputTest", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
        }),
    })

    // Verify output schema has emailId field
    expect(step.output.emailId).toBeDefined()
    expect(step.output.emailId).toBe(Schema.String)
  })

  it("should support array of recipients", () => {
    const process = new Process(unit, "TestProcess5", {
      name: "Test Process 5",
      purpose: "Testing multiple recipients",
    })

    const step = new ResendStep(process, "MultiRecipient", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: ["user1@example.com", "user2@example.com"],
          subject: "Test",
          html: "<p>Hello</p>",
          cc: "cc@example.com",
          bcc: "bcc@example.com",
          replyTo: "reply@example.com",
        }),
    })

    expect(step.from).toBe("Test <test@example.com>")
    expect(step.isSystemStep).toBe(true)
  })

  it("should support overriding from address in input", () => {
    const process = new Process(unit, "TestProcess6", {
      name: "Test Process 6",
      purpose: "Testing from override",
    })

    const step = new ResendStep(process, "FromOverride", {
      from: "Default <default@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          from: "Override <override@example.com>",
        }),
    })

    expect(step.from).toBe("Default <default@example.com>")
    expect(step.isSystemStep).toBe(true)
  })

  it("should support Resend templates", () => {
    const process = new Process(unit, "TestProcess7", {
      name: "Test Process 7",
      purpose: "Testing template support",
    })

    const step = new ResendStep(process, "TemplateSupport", {
      from: "Default <default@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          template: {
            id: "order-confirmation",
            variables: {
              PRODUCT: "Vintage Macintosh",
              PRICE: 499,
            },
          },
        }),
    })

    expect(step.from).toBe("Default <default@example.com>")
    expect(step.isSystemStep).toBe(true)
  })

  it("should allow omitting from when using a template", () => {
    const process = new Process(unit, "TestProcess8", {
      name: "Test Process 8",
      purpose: "Testing template sender defaults",
    })

    const step = new ResendStep(process, "TemplateDefaultFrom", {
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          template: {
            id: "order-confirmation",
            variables: {
              PRODUCT: "Vintage Macintosh",
            },
          },
        }),
    })

    expect(step.from).toBeUndefined()
    expect(step.isSystemStep).toBe(true)
  })
})

describe("ResendStep deferred mode", () => {
  const originalFetch = globalThis.fetch
  const org = new Organisation({ name: "TestOrg" })
  const unit = new OrgUnit(org, "test-unit", { name: "Test Unit" })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const makeBaseLayers = () =>
    Layer.provideMerge(
      Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
      FetchHttpClient.layer,
    )

  const makeDeferredLayer = (environment: string) =>
    Layer.succeed(ResendDeferredDelivery, { environment })

  const configProvider = ConfigProvider.fromMap(
    new Map([
      ["RESEND_API_KEY", "re_test"],
      ["RESEND_ENABLED", "true"],
    ]),
  )

  const rerouteConfigProvider = ConfigProvider.fromMap(
    new Map([
      ["RESEND_API_KEY", "re_test"],
      ["RESEND_ENABLED", "false"],
      ["RESEND_REROUTE_EMAIL", "reroute@example.com"],
    ]),
  )

  const mockFetchSuccess = (emailId = "email_deferred_001") => {
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response(JSON.stringify({ id: emailId }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
  }

  it("returns Completed when ResendDeferredDelivery is not provided", async () => {
    mockFetchSuccess()

    const process = new Process(unit, "DeferredTest1", {
      name: "Deferred Test 1",
      purpose: "Testing immediate fallback",
    })

    const step = new ResendStep(process, "ImmediateEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          {
            to: "user@example.com",
            subject: "Test",
            html: "<p>Hello</p>",
          },
          { todoId: "todo-001", stepPath: "/ImmediateEmail" },
        )
        .pipe(
          Effect.provide(makeBaseLayers()),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect((result as { _tag: string })._tag).toBe("Completed")
    if ((result as { _tag: string })._tag === "Completed") {
      expect((result as { output: Record<string, unknown> }).output).toEqual({
        emailId: "email_deferred_001",
      })
    }
  })

  it("returns Deferred with stateUpdate when ResendDeferredDelivery is provided", async () => {
    mockFetchSuccess("email_def_042")

    const process = new Process(unit, "DeferredTest2", {
      name: "Deferred Test 2",
      purpose: "Testing deferred mode",
    })

    const step = new ResendStep(process, "DeferredEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          {
            to: "user@example.com",
            subject: "Test",
            html: "<p>Hello</p>",
          },
          { todoId: "todo-def-042", stepPath: "/DeferredEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("production")),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect(isDeferredStepResult(result)).toBe(true)
    if (!isDeferredStepResult(result)) {
      return
    }

    expect(result.stateUpdate).toEqual({
      _internal: {
        resend: {
          emailId: "email_def_042",
          primaryTo: "user@example.com",
          environment: "production",
          todoId: "todo-def-042",
        },
      },
    })
  })

  it("captures deferred ResendStep sends through the mock plugin layer", async () => {
    const mock = makeMockResendPlugin({ environment: "staging" })

    const process = new Process(unit, "MockDeferredTest", {
      name: "Mock Deferred Test",
      purpose: "Testing mock deferred mode",
    })

    const step = new ResendStep(process, "MockDeferredEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    // executeStep's generic environment is wider than this layer-focused test.
    const result = await Effect.runPromise(
      step
        .executeStep(
          { to: "user@example.com", subject: "Test", html: "<p>Hello</p>" },
          { todoId: "todo-mock-deferred", stepPath: "/MockDeferredEmail" },
        )
        .pipe(Effect.provide(mock.layer)) as Effect.Effect<unknown>,
    )

    expect(isDeferredStepResult(result)).toBe(true)
    if (!isDeferredStepResult(result)) {
      return
    }

    expect(result.stateUpdate).toEqual({
      _internal: {
        resend: {
          emailId: "email_mock_000001",
          primaryTo: "user@example.com",
          environment: "staging",
          todoId: "todo-mock-deferred",
        },
      },
    })

    expect(
      mock.controller.findMessageByTodoId("todo-mock-deferred")?.request.tags,
    ).toEqual([
      { name: "pf_todo_id", value: "todo-mock-deferred" },
      { name: "pf_environment", value: "staging" },
    ])
  })

  it("attaches internal tags for webhook correlation", async () => {
    let capturedBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)
      capturedBody = JSON.parse(await request.text()) as Record<string, unknown>
      return new Response(JSON.stringify({ id: "email_tagged" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const process = new Process(unit, "DeferredTest3", {
      name: "Deferred Test 3",
      purpose: "Testing tag attachment",
    })

    const step = new ResendStep(process, "TaggedEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    await Effect.runPromise(
      step
        .executeStep(
          { to: "user@example.com", subject: "Test", html: "<p>Hello</p>" },
          { todoId: "todo-tags", stepPath: "/TaggedEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("staging")),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect(capturedBody).toBeDefined()
    expect(capturedBody?.["tags"]).toEqual([
      { name: "pf_todo_id", value: "todo-tags" },
      { name: "pf_environment", value: "staging" },
    ])
  })

  it("rejects array 'to' recipients in deferred mode", async () => {
    mockFetchSuccess()

    const process = new Process(unit, "DeferredTest4", {
      name: "Deferred Test 4",
      purpose: "Testing array rejection",
    })

    const step = new ResendStep(process, "ArrayReject", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: ["a@example.com", "b@example.com"],
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const exit = await Effect.runPromiseExit(
      step
        .executeStep(
          {
            to: ["a@example.com", "b@example.com"],
            subject: "Test",
            html: "<p>Hello</p>",
          },
          { todoId: "todo-arr", stepPath: "/ArrayReject" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("production")),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause))
      expect(failure).toMatchObject({
        _tag: "ResendError",
        message: expect.stringContaining("exactly one primary 'to'"),
      })
    }
  })

  it("allows cc and bcc in deferred mode", async () => {
    let capturedBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)
      capturedBody = JSON.parse(await request.text()) as Record<string, unknown>
      return new Response(JSON.stringify({ id: "email_cc" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const process = new Process(unit, "DeferredTest5", {
      name: "Deferred Test 5",
      purpose: "Testing cc/bcc support",
    })

    const step = new ResendStep(process, "CcBccEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "primary@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
          cc: "cc@example.com",
          bcc: "bcc@example.com",
        }),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          {
            to: "primary@example.com",
            subject: "Test",
            html: "<p>Hello</p>",
            cc: "cc@example.com",
            bcc: "bcc@example.com",
          },
          { todoId: "todo-cc", stepPath: "/CcBccEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("production")),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect((result as { _tag: string })._tag).toBe("Deferred")

    // Verify cc and bcc were sent to the API
    expect(capturedBody).toBeDefined()
    expect(capturedBody?.["cc"]).toBe("cc@example.com")
    expect(capturedBody?.["bcc"]).toBe("bcc@example.com")
    expect(capturedBody?.["to"]).toBe("primary@example.com")
  })

  it("stores environment from ResendDeferredDelivery in metadata", async () => {
    mockFetchSuccess("email_env")

    const process = new Process(unit, "DeferredTest6", {
      name: "Deferred Test 6",
      purpose: "Testing environment metadata",
    })

    const step = new ResendStep(process, "EnvEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          { to: "user@example.com", subject: "Test", html: "<p>Hello</p>" },
          { todoId: "todo-env", stepPath: "/EnvEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("staging")),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    expect((result as { _tag: string })._tag).toBe("Deferred")
    if ((result as { _tag: string })._tag === "Deferred") {
      const stateUpdate = (result as { stateUpdate: Record<string, unknown> })
        .stateUpdate
      const internal = stateUpdate["_internal"]
      expect(internal).toBeDefined()
      const resend = (internal as Record<string, unknown>)["resend"]
      expect(resend).toBeDefined()
      expect((resend as Record<string, unknown>)["environment"]).toBe("staging")
    }
  })

  it("stores the rerouted recipient for deferred webhook correlation", async () => {
    let capturedBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init)
      capturedBody = JSON.parse(await request.text()) as Record<string, unknown>
      return new Response(JSON.stringify({ id: "email_rerouted" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const process = new Process(unit, "DeferredTest7", {
      name: "Deferred Test 7",
      purpose: "Testing rerouted webhook metadata",
    })

    const step = new ResendStep(process, "ReroutedEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "parent@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          {
            to: "parent@example.com",
            subject: "Test",
            html: "<p>Hello</p>",
          },
          { todoId: "todo-reroute", stepPath: "/ReroutedEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(makeBaseLayers(), makeDeferredLayer("staging")),
          ),
          Effect.withConfigProvider(rerouteConfigProvider),
        ) as Effect.Effect<unknown>,
    )

    expect((result as { _tag: string })._tag).toBe("Deferred")
    if ((result as { _tag: string })._tag === "Deferred") {
      expect(
        (result as { stateUpdate: Record<string, unknown> }).stateUpdate,
      ).toEqual({
        _internal: {
          resend: {
            emailId: "email_rerouted",
            primaryTo: "reroute@example.com",
            environment: "staging",
            todoId: "todo-reroute",
          },
        },
      })
    }

    expect(capturedBody?.["tags"]).toEqual([
      { name: "pf_todo_id", value: "todo-reroute" },
      { name: "pf_environment", value: "staging" },
    ])
  })

  it("skips re-sending when process state already has resend metadata", async () => {
    // fetch should NOT be called — if it is, the mock will throw
    globalThis.fetch = (() => {
      throw new Error(
        "fetch called during idempotency guard — should have been skipped",
      )
    }) as unknown as typeof fetch

    const process = new Process(unit, "IdempotencyTest", {
      name: "Idempotency Test",
      purpose: "Testing retry safety",
    })

    const step = new ResendStep(process, "IdempotentEmail", {
      from: "Test <test@example.com>",
      input: () =>
        Effect.succeed({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Hello</p>",
        }),
    })

    const existingState = {
      _internal: {
        resend: {
          emailId: "re_already_sent",
          primaryTo: "user@example.com",
          environment: "production",
          todoId: "todo-idem-001",
        },
      },
    }

    const readerLayer = Layer.succeed(StepProcessStateReader, {
      getProcessStateByTodoId: () => Effect.succeed(existingState),
    })

    const result = await Effect.runPromise(
      step
        .executeStep(
          { to: "user@example.com", subject: "Test", html: "<p>Hello</p>" },
          { todoId: "todo-idem-001", stepPath: "/IdempotentEmail" },
        )
        .pipe(
          Effect.provide(
            Layer.merge(
              makeBaseLayers(),
              Layer.merge(makeDeferredLayer("production"), readerLayer),
            ),
          ),
          Effect.withConfigProvider(configProvider),
        ) as Effect.Effect<unknown>,
    )

    // Should return Deferred but without a stateUpdate
    expect((result as { _tag: string })._tag).toBe("Deferred")
    if ((result as { _tag: string })._tag === "Deferred") {
      expect((result as { stateUpdate: unknown }).stateUpdate).toBeUndefined()
    }
  })
})
