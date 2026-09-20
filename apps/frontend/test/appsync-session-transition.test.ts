import { AppSyncEventsClient } from "../lib/appsync-events/client"
import { expect, spyOn, test } from "bun:test"

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(..._args: unknown[]) {
    Socket.instances.push(this)
  }
  send(message: string) {
    this.sent.push(message)
  }
  close() {}
  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  subscribe() {
    this.message({ type: "connection_ack", connectionTimeoutMs: 300_000 })
    const message: unknown = JSON.parse(this.sent.at(-1) ?? "null")
    if (typeof message !== "object" || message === null || !("id" in message))
      throw new Error("No subscription")
    return message.id
  }
}

test("reconnect, expiry and late socket callbacks cannot carry old authority forward", () => {
  const oldSocket = globalThis.WebSocket
  const oldDocument = globalThis.document
  const document = { cookie: "access_token=one" }
  Reflect.set(globalThis, "WebSocket", Socket)
  Reflect.set(globalThis, "document", document)
  Socket.instances = []
  const events: string[] = []
  let current = true
  const expiresAt = Math.floor(Date.now() / 1000) + 60
  const client = new AppSyncEventsClient({
    realtimeUrl: "wss://example.test",
    httpHost: "example.test",
    channel: "/rxdb/collection/todo/user/r-one",
    isCurrent: () => current,
    expiresAt,
    onEvent: (event) => events.push(event),
  })
  try {
    client.connect()
    const first = Socket.instances.at(-1)
    if (!first) throw new Error("No socket")
    const firstId = first.subscribe()
    first.message({ type: "data", id: firstId, event: "permitted" })
    first.message({ type: "data", id: "other", event: "wrong-subscription" })
    client.reconnect()
    const second = Socket.instances.at(-1)
    if (!second) throw new Error("No socket")
    const secondId = second.subscribe()
    first.message({ type: "data", id: firstId, event: "late" })
    first.onclose?.()
    second.message({ type: "data", id: secondId, event: "reconnected" })
    const clock = spyOn(Date, "now").mockReturnValue(expiresAt * 1000)
    try {
      second.message({ type: "data", id: secondId, event: "exact-expiry" })
    } finally {
      clock.mockRestore()
    }
    current = false
    second.message({ type: "data", id: secondId, event: "old-authority" })
    current = true
    document.cookie = "access_token=two"
    second.message({ type: "data", id: secondId, event: "new-generation" })
    client.reconnect()
    expect(Socket.instances).toHaveLength(2)
    expect(events).toEqual(["permitted", "reconnected"])
    const expired = new AppSyncEventsClient({
      realtimeUrl: "wss://example.test",
      httpHost: "example.test",
      channel: "/rxdb/collection/todo/user/r-expired",
      expiresAt: 1,
      onEvent: () => {
        throw new Error("Expired delivery")
      },
    })
    expired.connect()
    expect(Socket.instances).toHaveLength(2)
  } finally {
    client.disconnect()
    Reflect.set(globalThis, "WebSocket", oldSocket)
    Reflect.set(globalThis, "document", oldDocument)
  }
})
