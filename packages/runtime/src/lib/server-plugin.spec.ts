import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  SERVER_PLUGIN_HOST_INTERFACE_VERSION,
  ServerPluginContractError,
  type ServerPluginRegistration,
  type WebhookCallbackHost,
  dispatchServerPluginWebhook,
  findWebhookDescriptor,
  parseServerPluginRegistrations,
} from "./server-plugin.js"

const handler = () => Effect.succeed(new Response("ok"))
const callbackHost: WebhookCallbackHost["Type"] = {
  lookupDeferredTodo: () => Effect.succeed(null),
  completeDeferredTodo: () => Effect.succeed({ _tag: "Ignored" }),
  failDeferredTodo: () => Effect.succeed({ _tag: "Ignored" }),
  applyPublicCompletionCallback: () => Effect.succeed({ _tag: "Ignored" }),
}

describe("server plugin registrations", () => {
  it("accepts a versioned job layer and generic webhook descriptor", async () => {
    const registrations = await Effect.runPromise(
      parseServerPluginRegistrations([
        {
          identity: "email.example",
          hostInterfaceVersion: SERVER_PLUGIN_HOST_INTERFACE_VERSION,
          jobLayer: Layer.empty,
          webhooks: [{ path: "/webhooks/email", handle: handler }],
        },
      ]),
    )

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.jobLayer).toBe(Layer.empty)
    expect(
      findWebhookDescriptor(registrations, "/webhooks/email")?.handle,
    ).toBe(handler)
    expect(findWebhookDescriptor(registrations, "/webhooks/missing")).toBe(
      undefined,
    )
  })

  it("treats a missing export as no plugin registrations", async () => {
    await expect(
      Effect.runPromise(parseServerPluginRegistrations(undefined)),
    ).resolves.toEqual([])
  })

  it("dispatches a registered webhook and returns 404 for an unknown path", async () => {
    const registrations: readonly ServerPluginRegistration[] = [
      {
        identity: "email.example",
        hostInterfaceVersion: SERVER_PLUGIN_HOST_INTERFACE_VERSION,
        webhooks: [{ path: "/webhooks/email", handle: handler }],
      },
    ]

    const matched = await Effect.runPromise(
      dispatchServerPluginWebhook({
        request: new Request("https://example.com/webhooks/email"),
        registrations,
        callbackHost,
      }),
    )
    const missing = await Effect.runPromise(
      dispatchServerPluginWebhook({
        request: new Request("https://example.com/webhooks/missing"),
        registrations,
        callbackHost,
      }),
    )

    expect(await matched.text()).toBe("ok")
    expect(missing.status).toBe(404)
  })

  it("rejects an incompatible host interface version", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseServerPluginRegistrations([
          { identity: "email.example", hostInterfaceVersion: 2 },
        ]),
      ),
    )

    expect(error).toBeInstanceOf(ServerPluginContractError)
    expect(error.message).toContain("requires host interface 2")
  })

  it("rejects duplicate identities and webhook paths", async () => {
    const duplicateIdentity = await Effect.runPromise(
      Effect.flip(
        parseServerPluginRegistrations([
          {
            identity: "email.example",
            hostInterfaceVersion: 1,
          },
          {
            identity: "email.example",
            hostInterfaceVersion: 1,
          },
        ]),
      ),
    )
    expect(duplicateIdentity.message).toContain(
      'duplicate server plugin identity "email.example"',
    )

    const duplicateWebhook = await Effect.runPromise(
      Effect.flip(
        parseServerPluginRegistrations([
          {
            identity: "email.one",
            hostInterfaceVersion: 1,
            webhooks: [{ path: "/webhooks/email", handle: handler }],
          },
          {
            identity: "email.two",
            hostInterfaceVersion: 1,
            webhooks: [{ path: "/webhooks/email", handle: handler }],
          },
        ]),
      ),
    )
    expect(duplicateWebhook.message).toContain("registered by both")
  })

  it("rejects routes outside generic webhook ingress", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseServerPluginRegistrations([
          {
            identity: "email.example",
            hostInterfaceVersion: 1,
            webhooks: [{ path: "/resend", handle: handler }],
          },
        ]),
      ),
    )

    expect(error.message).toContain("absolute /webhooks/... path")
  })
})
