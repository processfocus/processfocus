import { randomUUID } from "node:crypto"
import { supportCodeLibraryBuilder } from "@cucumber/cucumber"
import { SignJWT } from "jose"
import {
  type ProviderUserSession,
  getRealtimeRecipientId,
  isAppSyncChannelPath,
} from "@pf/auth-session"
import { getAppSyncRecipientId } from "./realtime-recipient"
import { describe, expect, it } from "bun:test"

supportCodeLibraryBuilder.reset(process.cwd(), randomUUID)
const { TestWorld } = await import("./world")
supportCodeLibraryBuilder.finalize()

const key = new TextEncoder().encode("local-e2e-recipient-routing-test-key")
// Fixed regression: the old human digest was IL-jR1ACb0_DQQ-P77lj_CI9HU0S-ucPVSJKxOs5KFA.
const exp = 2_000_000_026
const human: ProviderUserSession = {
  userId: "same-owner",
  email: "owner@example.com",
  roles: ["/Admin"],
  orgUnitId: "root",
  orgUnitPath: "/",
}
const signed = (claims: Record<string, unknown>): Promise<string> =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(key)

describe("AWS E2E canonical recipients", () => {
  it("preserves full human, delegation and service facts without owner fallback", async () => {
    const delegation = {
      id: "delegate",
      generationId: "generation",
      name: "Agent",
      expiresAt: (exp + 600) * 1000,
    }
    const fixtures = [
      { type: "providerUser", properties: human, exp },
      {
        type: "providerUser",
        properties: { ...human, roles: ["/Worker"] },
        exp,
      },
      { type: "providerUser", properties: human, exp: exp + 1 },
      { type: "providerUser", properties: { ...human, delegation }, exp },
      {
        type: "providerUser",
        properties: {
          ...human,
          delegation: { ...delegation, generationId: "replacement" },
        },
        exp,
      },
      {
        type: "user",
        properties: {
          userId: human.userId,
          clientId: "service",
          roles: ["/Worker"],
          orgUnitId: "",
          orgUnitPath: "",
        },
        exp,
      },
    ]
    const recipients: string[] = []
    for (const fixture of fixtures) {
      const recipient = await getAppSyncRecipientId(
        await signed({ ...fixture, mode: "access", sub: "not-the-owner" }),
      )
      expect(recipient).toBe(
        (await getRealtimeRecipientId(fixture.properties, fixture.exp))!,
      )
      expect(recipient).not.toBe(human.userId)
      recipients.push(recipient)
    }
    expect(new Set(recipients).size).toBe(fixtures.length)
  })

  it("rejects absent, malformed and expired token facts rather than building a legacy address", async () => {
    for (const claims of [
      { type: "providerUser", sub: "fallback-owner", exp },
      { type: "providerUser", properties: { userId: "fallback-owner" }, exp },
      { type: "providerUser", properties: human },
      { type: "providerUser", properties: human, exp: 1 },
      {
        type: "providerUser",
        properties: { ...human, delegation: { id: "delegate" } },
        exp,
      },
      {
        type: "user",
        properties: { userId: "owner", clientId: "service", delegation: null },
        exp,
      },
      { type: "unknown", properties: human, exp },
    ]) {
      await expect(
        getAppSyncRecipientId(await signed({ mode: "access", ...claims })),
      ).rejects.toThrow("Invalid access token facts")
    }
    await expect(getAppSyncRecipientId("not-a-token")).rejects.toThrow(
      "Invalid access token facts",
    )
  })

  it("uses actual target-session recipients in primary, named and cross-user World subscriptions", async () => {
    const adminToken = await signed({
      mode: "access",
      type: "providerUser",
      properties: human,
      exp,
    })
    const worker = { ...human, roles: ["/Worker"] }
    const workerToken = await signed({
      mode: "access",
      type: "providerUser",
      properties: worker,
      exp,
    })
    const adminChannel = `/rxdb/collection/todo/user/${await getRealtimeRecipientId(human, exp)}`
    const workerChannel = `/rxdb/collection/todo/user/${await getRealtimeRecipientId(worker, exp)}`
    const received: { channel: string; authenticatedAsAdmin: boolean }[] = []
    let rejectSubscription = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) =>
        server.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": "aws-appsync-event-ws" },
        })
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
          if (message.type === "connection_init")
            socket.send(
              JSON.stringify({
                type: "connection_ack",
                connectionTimeoutMs: 30000,
              }),
            )
          if (
            message.type !== "subscribe" ||
            !("channel" in message) ||
            typeof message.channel !== "string" ||
            !("id" in message) ||
            typeof message.id !== "string"
          )
            return
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
          const auth =
            "authorization" in message ? message.authorization : undefined
          received.push({
            channel: message.channel,
            authenticatedAsAdmin:
              typeof auth === "object" &&
              auth !== null &&
              "authorization" in auth &&
              auth.authorization === adminToken,
          })
          socket.send(
            JSON.stringify(
              rejectSubscription
                ? {
                    type: "subscribe_error",
                    id: message.id,
                    errors: [
                      { errorType: "Unauthorized", message: "Not authorized" },
                    ],
                  }
                : { type: "subscribe_success", id: message.id },
            ),
          )
          if (!rejectSubscription)
            socket.send(
              JSON.stringify({
                type: "data",
                id: message.id,
                event: JSON.stringify({ documents: [{ id: "todo" }] }),
              }),
            )
        },
      },
    })
    const previousHost = process.env["APPSYNC_EVENTS_HTTP_HOST"]
    const previousUrl = process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"]
    process.env["APPSYNC_EVENTS_HTTP_HOST"] = "local-test"
    process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"] =
      `ws://127.0.0.1:${server.port}`
    const world = new TestWorld({
      attach: async () => {},
      log: () => {},
      link: () => {},
      parameters: {},
    })
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
      world.accessToken = adminToken
      await world.subscribe("subscription { streamTodo { documents { id } } }")
      await world.waitForEvents(1)
      world.userSessions.set("Admin", {
        accessToken: adminToken,
        subscriptions: {},
      })
      world.userSessions.set("Worker", {
        accessToken: workerToken,
        subscriptions: {},
      })
      await world.subscribeUserToTodos("Worker")
      rejectSubscription = true
      expect(
        await world.trySubscribeToOtherUserChannel("Admin", "todo", "Worker"),
      ).toBeInstanceOf(Error)
      expect(received).toEqual([
        { channel: adminChannel, authenticatedAsAdmin: true },
        { channel: workerChannel, authenticatedAsAdmin: false },
        { channel: workerChannel, authenticatedAsAdmin: true },
      ])
      world.userSessions.set("Invalid", {
        accessToken: "not-a-token",
        subscriptions: {},
      })
      await expect(world.subscribeUserToTodos("Invalid")).rejects.toThrow(
        "Invalid access token facts",
      )
      await expect(
        world.trySubscribeToOtherUserChannel("Admin", "todo", "Invalid"),
      ).rejects.toThrow("Invalid access token facts")
      await expect(
        world.trySubscribeToOtherUserChannel("Admin", "todo", "Admin"),
      ).rejects.toThrow("distinct realtime recipients")
      expect(received).toHaveLength(3)
      world.accessToken = "not-a-token"
      await world.subscribe("subscription { streamTodo { documents { id } } }")
      expect(world.subscriptionError?.message).toContain(
        "Invalid access token facts",
      )
      expect(received).toHaveLength(3)
    } finally {
      world.unsubscribe()
      world.unsubscribeAllUsers()
      await server.stop(true)
      if (previousHost === undefined)
        delete process.env["APPSYNC_EVENTS_HTTP_HOST"]
      else process.env["APPSYNC_EVENTS_HTTP_HOST"] = previousHost
      if (previousUrl === undefined)
        delete process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"]
      else process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"] = previousUrl
    }
  })
})
