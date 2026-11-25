import { AppSyncEventsClient, SubscriptionPresenceLease } from "../src"
import { expect, it } from "bun:test"

it("uses caller credentials and waits for subscription acknowledgement before catch-up", async () => {
  const deliveries: string[] = []
  const actions: string[] = []
  let sendEvent = () => {}
  const received = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (request.method === "POST") {
        const credential = JSON.parse(
          request.headers.get("authorization") || "{}",
        )
        actions.push(credential.action)
        expect(credential.token).toBe("memory-ticket")
        if (credential.action === "open") setTimeout(sendEvent, 20)
        return Response.json({ successful: [], failed: [] })
      }
      expect(request.headers.get("sec-websocket-protocol")).toContain(
        "aws-appsync-event-ws",
      )
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message: unknown = JSON.parse(String(raw))
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
              connectionTimeoutMs: 300000,
            }),
          )
        }
        if (message.type === "subscribe" && "id" in message) {
          expect(deliveries).toEqual([])
          expect(actions).toEqual([])
          expect(message).toMatchObject({
            channel: "/rxdb/collection/projects/user/recipient",
            authorization: {
              host: `localhost:${server.port}`,
            },
          })
          socket.send(
            JSON.stringify({ type: "subscribe_success", id: "obsolete" }),
          )
          socket.send(
            JSON.stringify({ type: "subscribe_success", id: message.id }),
          )
          sendEvent = () =>
            socket.send(
              JSON.stringify({
                type: "data",
                id: message.id,
                event: "invalidation",
              }),
            )
        }
      },
    },
  })
  const client = new AppSyncEventsClient({
    realtimeUrl: `ws://localhost:${server.port}`,
    httpHost: `localhost:${server.port}`,
    heartbeatMs: 100,
    channel: "/rxdb/collection/projects/user/recipient",
    getToken: () => "memory-ticket",
    onSubscribed: () => deliveries.push("catch-up"),
    onEvent: (event) => {
      deliveries.push(event)
      received.resolve()
    },
    onError: received.reject,
  })
  try {
    client.connect()
    await received.promise
    expect(deliveries).toEqual(["catch-up", "invalidation"])
    await Bun.sleep(240)
    expect(
      actions.filter((action) => action === "renew").length,
    ).toBeGreaterThanOrEqual(2)
    expect(deliveries).toEqual(["catch-up", "invalidation"])
    // A delayed heartbeat restores presence before asking for missed changes.
    Bun.sleepSync(220)
    await Bun.sleep(50)
    expect(deliveries).toEqual(["catch-up", "invalidation", "catch-up"])
  } finally {
    await client.disconnect()
    expect(actions.at(-1)).toBe("remove")
    server.stop(true)
  }
})

it("catches up after response latency lets a renewable lease expire", async () => {
  // Accelerate the supported 10s lease / 3s heartbeat / 8.5s response example.
  const leaseMs = 1000
  const heartbeatMs = 300
  const responseDelayMs = 850
  const secondResponse = Promise.withResolvers<void>()
  let leaseExpiresAt = 0
  let renewals = 0
  let revision = 0
  let seenRevision = -1
  let catchUps = 0
  let missedWhileExpired = false
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const credential = JSON.parse(
        request.headers.get("authorization") || "{}",
      )
      if (credential.action === "open" || credential.action === "renew")
        leaseExpiresAt = Date.now() + leaseMs
      if (credential.action === "renew") {
        renewals++
        if (renewals === 1)
          changeTimer = setTimeout(() => {
            revision++
            missedWhileExpired = Date.now() >= leaseExpiresAt
          }, leaseMs + 50)
        await Bun.sleep(responseDelayMs)
        if (renewals === 2) secondResponse.resolve()
      }
      return Response.json({ successful: [], failed: [] })
    },
  })
  const lease = new SubscriptionPresenceLease({
    token: "test-token",
    httpHost: `localhost:${server.port}`,
    channel: "/rxdb/collection/todo/user/recipient",
    heartbeatMs,
    onReady: () => {
      catchUps++
      seenRevision = revision
    },
    onLost: () => {
      throw new Error("Successful renewal lost presence")
    },
  })
  try {
    await lease.start()
    expect(seenRevision).toBe(0)
    await secondResponse.promise
    await Bun.sleep(30)
    expect(missedWhileExpired).toBe(true)
    expect(catchUps).toBe(2)
    expect(seenRevision).toBe(1)
  } finally {
    if (changeTimer) clearTimeout(changeTimer)
    await lease.stop()
    await server.stop(true)
  }
})

it("resubscribes after lease loss and cannot adopt another session's credentials", async () => {
  const resumed = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  const actions: string[] = []
  const events: string[] = []
  let token = "first-session"
  let subscriptions = 0
  let catchUps = 0
  let rejectRenewal = true
  let sendEvent = (_event: string) => {}
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (request.method === "POST") {
        const credential = JSON.parse(
          request.headers.get("authorization") || "{}",
        )
        expect(credential.token).toBe("first-session")
        actions.push(credential.action)
        if (credential.action === "renew" && rejectRenewal) {
          rejectRenewal = false
          return new Response(null, { status: 403 })
        }
        return Response.json({ successful: [], failed: [] })
      }
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.type === "connection_init")
          socket.send(
            JSON.stringify({
              type: "connection_ack",
              connectionTimeoutMs: 300000,
            }),
          )
        if (message.type === "subscribe") {
          subscriptions++
          sendEvent = (event) =>
            socket.send(JSON.stringify({ type: "data", id: message.id, event }))
          socket.send(
            JSON.stringify({ type: "subscribe_success", id: message.id }),
          )
        }
      },
    },
  })
  const client = new AppSyncEventsClient({
    realtimeUrl: `ws://localhost:${server.port}`,
    httpHost: `localhost:${server.port}`,
    channel: "/rxdb/collection/projects/user/recipient",
    heartbeatMs: 100,
    getToken: () => token,
    onSubscribed: () => {
      catchUps++
      if (catchUps === 2) resumed.resolve()
    },
    onEvent: (event) => {
      events.push(event)
      delivered.resolve()
    },
    onError: resumed.reject,
  })
  try {
    client.connect()
    await resumed.promise
    expect(subscriptions).toBe(2)
    expect(actions.slice(0, 4)).toEqual(["open", "renew", "remove", "open"])
    sendEvent("after-reconnect")
    await delivered.promise
    token = "second-session"
    sendEvent("stale-session")
    await Bun.sleep(30)
    expect(events).toEqual(["after-reconnect"])
    await client.disconnect()
    client.connect()
    await Bun.sleep(1100)
    expect(subscriptions).toBe(2)
    expect(catchUps).toBe(2)
    expect(actions.at(-1)).toBe("remove")
  } finally {
    await client.disconnect()
    server.stop(true)
  }
})
