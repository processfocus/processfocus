import { createHmac } from "node:crypto"
import { Effect, Result } from "effect"
import {
  type ProviderUserSession,
  type Session,
  getRealtimeRecipientId,
  isAppSyncChannelPath,
} from "@pf/auth-session"
import {
  type RealtimeRecipientId,
  isRealtimeRecipientId,
} from "@pf/auth-session/realtime-recipient"
import { createExecutionEventSource } from "../src/utils/execution-subscription"
import { waitForExecutionToFinish } from "../src/utils/execution-wait"
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

it.each([
  { interruption: "close", status: "Completed" },
  { interruption: "terminate", status: "Failed" },
  { interruption: "protocol", status: "Completed" },
] as const)(
  "waits for persisted $status after $interruption, but preserves protocol errors",
  async ({ interruption, status }) => {
    const interrupt = Promise.withResolvers<() => void>()
    const messages: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) =>
        request.method === "POST"
          ? Response.json({ successful: [], failed: [] })
          : server.upgrade(request)
            ? undefined
            : new Response("upgrade required"),
      websocket: {
        message(socket, data) {
          const message: unknown = JSON.parse(data.toString())
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message)
          )
            return
          if (message.type === "connection_init")
            socket.send(JSON.stringify({ type: "connection_ack" }))
          if (message.type === "subscribe" && "id" in message) {
            socket.send(
              JSON.stringify({ type: "subscribe_success", id: message.id }),
            )
            interrupt.resolve(() => {
              if (interruption === "close")
                socket.close(1000, "server maintenance")
              else if (interruption === "terminate") socket.terminate()
              else
                socket.send(
                  JSON.stringify({
                    type: "error",
                    errors: [{ message: "Execution access denied" }],
                  }),
                )
            })
          }
        },
      },
    })
    let snapshotFetches = 0
    try {
      const source = await Effect.runPromise(
        createExecutionEventSource({
          kind: "APPSYNC_EVENTS",
          realtimeUrl: `ws://127.0.0.1:${server.port}`,
          appSyncEventsHttpHost: `127.0.0.1:${server.port}`,
          userId: properties.userId,
          accessToken: token({
            mode: "access",
            type: "providerUser",
            properties,
            exp,
          }),
        }),
      )
      try {
        const result = Effect.runPromise(
          Effect.result(
            waitForExecutionToFinish(source, "exec-1", {
              executionLabel: "deployment",
              timeoutMs: 20,
              heartbeatMs: 60_000,
              maxWaitMs: 1_000,
              hasPendingInitialLine: false,
              quiet: true,
              formatLogMessage: (message) => {
                messages.push(message)
                return message
              },
              fetchSnapshot: async () => {
                snapshotFetches++
                if (snapshotFetches === 1)
                  throw new Error("temporary snapshot failure")
                return {
                  id: "exec-1",
                  status: snapshotFetches === 2 ? "Running" : status,
                  steps: [],
                  failureReason:
                    status === "Failed" ? "deployment failed" : null,
                  abandonedReason: null,
                  finishedAt: null,
                }
              },
            }),
          ),
        )
        ;(await interrupt.promise)()
        const outcome = await result
        if (interruption === "protocol") {
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome))
            expect(outcome.failure.message).toContain("Execution access denied")
          expect(snapshotFetches).toBe(0)
        } else {
          expect(Result.isSuccess(outcome)).toBe(true)
          if (Result.isSuccess(outcome))
            expect(outcome.success.status).toBe(status)
          expect(snapshotFetches).toBe(3)
          if (interruption === "close")
            expect(messages.join("\n")).toContain(
              "code=1000 reason=server maintenance",
            )
        }
      } finally {
        await source.close()
      }
    } finally {
      await server.stop(true)
    }
  },
)

describe("CLI AppSync execution recipient addressing", () => {
  it("uses the full token authority and expiry rather than caller userId or sub", async () => {
    const channels: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) =>
        request.method === "POST"
          ? Response.json({ successful: [], failed: [] })
          : server.upgrade(request)
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
    const cases: readonly { properties: Session; exp: number }[] = [
      {
        properties: {
          userId: "machine-owner",
          clientId: "deployment-machine",
          roles: ["/Workload deploy"],
          workload: {
            bindingId: "deployment-machine",
            repositoryId: "123",
            repositoryOwnerId: "456",
            workflowRef:
              "org/repo/.github/workflows/deploy.yml@refs/heads/main",
            ref: "refs/heads/main",
            event: "workflow_dispatch",
            environment: "console",
            sha: "abc",
            runId: "789",
            runAttempt: "1",
            expiresAt: exp * 1000,
          },
        },
        exp,
      },
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
            appSyncEventsHttpHost: `127.0.0.1:${server.port}`,
            accessToken: token({
              ...claims,
              type: "clientId" in claims.properties ? "user" : "providerUser",
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
        }).pipe(Effect.result),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain("CLI access token")
        expect(result.failure.message).toContain("pfcli auth login")
        expect(result.failure.message.includes(accessToken)).toBe(false)
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

it.each(["ready", "cancel", "error", "close during presence registration"])(
  "waits for AppSync subscription acknowledgement and cleans up on %s",
  async (mode) => {
    const subscribed = Promise.withResolvers<() => void>()
    const closed = Promise.withResolvers<void>()
    const releaseRegistration = Promise.withResolvers<void>()
    let ready = false
    let closeDuringPresence = () => {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        if (request.method === "POST") {
          const credential = JSON.parse(
            request.headers.get("authorization") || "{}",
          )
          if (
            mode === "close during presence registration" &&
            credential.action === "open"
          ) {
            closeDuringPresence()
            // Server-side closure does not establish client-side close ordering.
            await releaseRegistration.promise
          }
          return Response.json({ successful: [], failed: [] })
        }
        if (server.upgrade(request)) return
        return new Response("upgrade required")
      },
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
          if (message.type === "subscribe" && "id" in message) {
            closeDuringPresence = () =>
              socket.close(1001, "registration interrupted")
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
          }
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
          appSyncEventsHttpHost: `127.0.0.1:${server.port}`,
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
          Effect.result,
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
        const outcome = await Promise.race([
          result,
          Bun.sleep(1000).then(() => "pending" as const),
        ])
        if (outcome === "pending")
          throw new Error(
            "Acquisition remained pending after the acknowledged socket closed",
          )
        if (mode === "close during presence registration") {
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome))
            expect(outcome.failure.message).toContain(
              "AppSync socket closed unexpectedly",
            )
          expect(ready).toBe(false)
        } else if (mode === "error") {
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome))
            expect(outcome.failure.message).toContain("Execution access denied")
        } else {
          expect(Result.isSuccess(outcome)).toBe(true)
          if (Result.isSuccess(outcome)) {
            const event = await outcome.success[Symbol.asyncIterator]().next()
            expect(event.value?.failureReason).toBe("credit rejected")
            await outcome.success.close()
          }
        }
      }
      await closed.promise
    } finally {
      releaseRegistration.resolve()
      controller.abort()
      await server.stop(true)
    }
  },
)
