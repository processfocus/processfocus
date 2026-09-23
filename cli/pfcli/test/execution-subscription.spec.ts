import { createHmac } from "node:crypto"
import { Effect, Either } from "effect"
import {
  type ProviderUserSession,
  getRealtimeRecipientId,
  isAppSyncChannelPath,
} from "@pf/auth-session"
import {
  type RealtimeRecipientId,
  isRealtimeRecipientId,
} from "@pf/auth-session/realtime-recipient"
import { createExecutionEventSource } from "../src/utils/execution-subscription"
import { describe, expect, it } from "bun:test"

const token = (claims: unknown): string => {
  const body = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`
  return `${body}.${createHmac("sha256", "local-test-signing-key").update(body).digest("base64url")}`
}
const properties: ProviderUserSession = {
  userId: "token-owner",
  email: "owner@example.com",
  roles: ["/Admin"],
  orgUnitId: "root",
  orgUnitPath: "/",
}
// Fixed regression: the old human digest was hv_jefmQIYl_-hdYFm3mQOpZLhDhGHD9kB0AdqIIktc.
const exp = 2_000_000_026

describe("CLI AppSync execution recipient addressing", () => {
  it("uses the full token authority and expiry rather than caller userId or sub", async () => {
    const channels: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) =>
        server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 400 }),
      websocket: {
        message: (socket, data) => {
          const message: unknown = JSON.parse(data.toString())
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message)
          )
            return
          if (message.type === "connection_init") {
            socket.send(
              JSON.stringify({
                type: "connection_ack",
                connectionTimeoutMs: 30000,
              }),
            )
          } else if (
            message.type === "subscribe" &&
            "id" in message &&
            typeof message.id === "string" &&
            "channel" in message &&
            typeof message.channel === "string"
          ) {
            // AppSync validates channel grammar before authorizer admission.
            if (!isAppSyncChannelPath(message.channel)) {
              socket.send(
                JSON.stringify({
                  type: "subscribe_error",
                  id: message.id,
                  errors: [
                    {
                      errorType: "BadRequestException",
                      message: "Invalid Channel Format",
                    },
                  ],
                }),
              )
              return
            }
            channels.push(message.channel)
            socket.send(
              JSON.stringify({ type: "subscribe_success", id: message.id }),
            )
            socket.send(
              JSON.stringify({
                type: "data",
                id: message.id,
                event: JSON.stringify({
                  documents: [
                    {
                      id: "execution",
                      status: "Completed",
                      failureReason: null,
                      abandonedReason: null,
                      finishedAt: null,
                      steps: [],
                    },
                  ],
                }),
              }),
            )
          }
        },
      },
    })
    const delegation = {
      id: "delegate",
      generationId: "generation",
      name: "Agent",
      expiresAt: (exp + 600) * 1000,
    }
    const cases: readonly { properties: ProviderUserSession; exp: number }[] = [
      { properties, exp },
      { properties: { ...properties, roles: ["/Worker"] }, exp },
      { properties, exp: exp + 60 },
      { properties: { ...properties, delegation }, exp },
      {
        properties: {
          ...properties,
          delegation: { ...delegation, generationId: "replacement" },
        },
        exp,
      },
      {
        properties: {
          ...properties,
          delegation,
          delegationRoleSelection: ["/Admin"],
        },
        exp,
      },
    ]
    try {
      const invalidResponse = await new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${server.port}`,
          "aws-appsync-event-ws",
        )
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "subscribe",
              id: "invalid-channel",
              channel:
                "/rxdb/collection/todo/user/r-OpkHcIOgkPMYtdi_u8LptCz2QHPbnJo-ROkn29r_4kQ",
            }),
          )
        socket.onmessage = (event) => {
          socket.close()
          resolve(JSON.parse(String(event.data)))
        }
        socket.onerror = () => {
          socket.close()
          reject(new Error("Test socket failed"))
        }
      })
      expect(invalidResponse).toMatchObject({
        type: "subscribe_error",
        errors: [
          {
            errorType: "BadRequestException",
            message: "Invalid Channel Format",
          },
        ],
      })
      for (const claims of cases) {
        const source = await Effect.runPromise(
          createExecutionEventSource({
            kind: "APPSYNC_EVENTS",
            realtimeUrl: `ws://127.0.0.1:${server.port}`,
            appSyncEventsHttpHost: "test.appsync-api.us-east-1.amazonaws.com",
            accessToken: token({
              ...claims,
              type: "providerUser",
              mode: "access",
              sub: "different-sub-owner",
            }),
            userId: "different-caller-owner",
          }),
        )
        try {
          expect(channels.at(-1)).toBe(
            `/rxdb/collection/execution/user/${await getRealtimeRecipientId(claims.properties, claims.exp)}`,
          )
          expect(await source[Symbol.asyncIterator]().next()).toMatchObject({
            done: false,
            value: { id: "execution", status: "Completed" },
          })
        } finally {
          await source.close()
        }
      }
      expect(new Set(channels).size).toBe(cases.length)
    } finally {
      await server.stop(true)
    }
  })

  it.each([
    "malformed-token",
    token({ mode: "access", type: "providerUser", sub: "fallback-owner", exp }),
    token({
      mode: "access",
      type: "providerUser",
      properties: { userId: "fallback-owner" },
      exp,
    }),
    token({ mode: "access", type: "providerUser", properties }),
    token({ mode: "access", type: "providerUser", properties, exp: 1 }),
    token({ mode: "refresh", type: "providerUser", properties, exp }),
    token({
      mode: "access",
      type: "providerUser",
      properties: { ...properties, delegation: { id: "delegate" } },
      exp,
    }),
    token({
      mode: "access",
      type: "user",
      properties: { userId: "owner", clientId: "service" },
      exp,
    }),
  ])(
    "rejects unusable token claims before opening a socket",
    async (accessToken) => {
      const result = await Effect.runPromise(
        createExecutionEventSource({
          kind: "APPSYNC_EVENTS",
          realtimeUrl: "not-a-websocket-url",
          appSyncEventsHttpHost: "unused",
          accessToken,
          userId: "fallback-owner",
        }).pipe(Effect.either),
      )
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("CLI access token")
        expect(result.left.message).toContain("pfcli auth login")
        expect(result.left.message.includes(accessToken)).toBe(false)
      }
    },
  )
})

it("narrows wire strings to branded realtime recipient IDs only after validation", async () => {
  const value: string = `r3-${"A".repeat(43)}`
  // @ts-expect-error A wire string has not been validated as a recipient ID.
  value satisfies RealtimeRecipientId
  expect(isRealtimeRecipientId(value)).toBe(true)
  if (isRealtimeRecipientId(value)) {
    value satisfies RealtimeRecipientId
  }
  const encoded = await getRealtimeRecipientId(
    { userId: "owner", clientId: "client" },
    2_000_000_000,
  )
  encoded satisfies RealtimeRecipientId | undefined
})

it.each(["ready", "cancel", "error"])(
  "waits for AppSync subscription acknowledgement and cleans up on %s",
  async (mode) => {
    const subscribed = Promise.withResolvers<() => void>()
    const closed = Promise.withResolvers<void>()
    let ready = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) =>
        server.upgrade(request) ? undefined : new Response("upgrade required"),
      websocket: {
        message: (socket, data) => {
          const message: unknown = JSON.parse(data.toString())
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message)
          )
            return
          if (message.type === "connection_init")
            socket.send(JSON.stringify({ type: "connection_ack" }))
          if (message.type === "subscribe" && "id" in message)
            subscribed.resolve(() => {
              if (mode === "error") {
                socket.send(
                  JSON.stringify({
                    type: "subscribe_error",
                    id: message.id,
                    errors: [
                      {
                        errorType: "Unauthorized",
                        message: "Execution access denied",
                      },
                    ],
                  }),
                )
                return
              }
              // A terminal update received during setup must be queued until consumed.
              socket.send(
                JSON.stringify({
                  type: "data",
                  id: message.id,
                  event: JSON.stringify({
                    documents: [
                      {
                        id: "early",
                        status: "Failed",
                        steps: [],
                        failureReason: "credit rejected",
                      },
                    ],
                  }),
                }),
              )
              socket.send(
                JSON.stringify({ type: "subscribe_success", id: message.id }),
              )
            })
        },
        close: () => closed.resolve(),
      },
    })
    const controller = new AbortController()
    try {
      const result = Effect.runPromise(
        createExecutionEventSource({
          kind: "APPSYNC_EVENTS",
          realtimeUrl: `ws://127.0.0.1:${server.port}`,
          appSyncEventsHttpHost: "local.test",
          userId: properties.userId,
          accessToken: token({
            mode: "access",
            type: "providerUser",
            properties,
            exp,
          }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              ready = true
            }),
          ),
          Effect.either,
        ),
        { signal: controller.signal },
      )
      const acknowledge = await subscribed.promise
      expect(ready).toBe(false)
      if (mode === "cancel") {
        controller.abort()
        await expect(result).rejects.toThrow()
      } else {
        acknowledge()
        const outcome = await result
        if (mode === "error") {
          expect(Either.isLeft(outcome)).toBe(true)
          if (Either.isLeft(outcome))
            expect(outcome.left.message).toContain("Execution access denied")
        } else {
          expect(Either.isRight(outcome)).toBe(true)
          if (Either.isRight(outcome)) {
            const event = await outcome.right[Symbol.asyncIterator]().next()
            expect(event.value?.failureReason).toBe("credit rejected")
            await outcome.right.close()
          }
        }
      }
      await closed.promise
    } finally {
      controller.abort()
      await server.stop(true)
    }
  },
)
