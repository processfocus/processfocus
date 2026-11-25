import {
  makeServerPluginJobLayer,
  validateConfiguration,
} from "@processfocus/runtime"
import { Config, ConfigProvider, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Organisation, Process } from "@pf/process"
import { makeResendDeferredDeliveryConfiguration } from "./resend-configuration"
import { makeResendServerPlugin } from "./resend-server-plugin"
import { ResendStep } from "./resend-step"
import { describe, expect, it } from "bun:test"

describe("Resend delivery policy", () => {
  // Exercise the registered worker and executable preflight contract, not a
  // manually supplied delivery capability. The transport is the only adapter.
  it.each([
    { wait: undefined, defaultWait: true, enabled: "true", deferred: true },
    { wait: undefined, defaultWait: true, enabled: "false", deferred: true },
    { wait: "false", defaultWait: true, enabled: "false", deferred: false },
    { wait: undefined, defaultWait: false, enabled: "true", deferred: false },
    { wait: "true", defaultWait: false, enabled: "true", deferred: true },
  ])(
    "sends with effective policy %j",
    async ({ wait, defaultWait, enabled, deferred }) => {
      const plugin = makeResendServerPlugin({
        deliveryConfiguration: makeResendDeferredDeliveryConfiguration(
          Config.succeed(defaultWait),
        ),
      })
      const config = ConfigProvider.fromEnvRecord({
        RESEND_API_KEY: "re_test",
        RESEND_ENABLED: enabled,
        RESEND_REROUTE_EMAIL: "reroute@example.com",
        ...(wait === undefined ? {} : { RESEND_WAIT_FOR_DELIVERY: wait }),
      })
      let sends = 0
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            sends++
            expect(request.url).toBe("https://api.resend.com/emails")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ id: "accepted-email" }),
            )
          }),
        ),
      )
      const process = new Process(
        new Organisation({ name: "Policy" }),
        "send",
        { name: "Send", purpose: "Verify configured delivery completion" },
      )
      const step = new ResendStep(process, "Email", {
        from: "sender@example.com",
        input: () =>
          Effect.succeed({
            to: "person@example.com",
            subject: "Hello",
            text: "Hi",
          }),
      })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const diagnostics = yield* validateConfiguration({
            version: 1,
            groups: plugin.configuration,
          })
          expect(diagnostics.map(({ key }) => key)).toEqual(
            deferred ? ["RESEND_WEBHOOK_SECRET"] : [],
          )
          return yield* step.executeStep(
            { to: "person@example.com", subject: "Hello", text: "Hi" },
            { todoId: "todo-policy", stepPath: "/send/Email" },
          )
        }).pipe(
          Effect.provide(
            Layer.provide(makeServerPluginJobLayer([plugin]), http),
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        ) as Effect.Effect<unknown>,
      )
      expect(sends).toBe(1)
      expect(result).toMatchObject(
        deferred
          ? {
              _tag: "Deferred",
              stateUpdate: {
                _internal: { resend: { emailId: "accepted-email" } },
              },
            }
          : { _tag: "Completed", output: { emailId: "accepted-email" } },
      )
    },
  )

  it("rejects an invalid explicit boolean instead of falling back to the organisation default", async () => {
    const plugin = makeResendServerPlugin({
      deliveryConfiguration: makeResendDeferredDeliveryConfiguration(
        Config.succeed(false),
      ),
    })
    const diagnostics = await Effect.runPromise(
      validateConfiguration({ version: 1, groups: plugin.configuration }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            RESEND_API_KEY: "re_test",
            RESEND_ENABLED: "true",
            RESEND_WAIT_FOR_DELIVERY: "invalid",
          }),
        ),
      ),
    )
    expect(diagnostics.map(({ key }) => key)).toContain(
      "RESEND_WAIT_FOR_DELIVERY",
    )
  })

  it("does not complete a rejected send when waiting is disabled", async () => {
    const plugin = makeResendServerPlugin()
    const process = new Process(
      new Organisation({ name: "Rejected" }),
      "send",
      { name: "Send", purpose: "Verify rejected sends fail" },
    )
    const step = new ResendStep(process, "Email", {
      from: "sender@example.com",
      input: () =>
        Effect.succeed({
          to: "person@example.com",
          subject: "Hello",
          text: "Hi",
        }),
    })
    const result = await Effect.runPromiseExit(
      step
        .executeStep(
          { to: "person@example.com", subject: "Hello", text: "Hi" },
          { todoId: "todo-rejected", stepPath: "/send/Email" },
        )
        .pipe(
          Effect.provide(
            Layer.provide(
              makeServerPluginJobLayer([plugin]),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      Response.json({ message: "Rejected" }, { status: 422 }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({
              RESEND_API_KEY: "re_test",
              RESEND_ENABLED: "true",
              RESEND_WAIT_FOR_DELIVERY: "false",
            }),
          ),
        ) as Effect.Effect<unknown>,
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).toContain("Rejected")
  })
})
