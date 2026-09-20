import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { type RxCollection, type RxJsonSchema, createRxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { matchesRealtimeSessionToken } from "../lib/auth/realtime-session-token"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { clearReplicationRegistry } from "../lib/collections/replication-registry"
import { expect, mock, test } from "bun:test"

const human = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Worker"],
  orgUnitId: "org",
  orgUnitPath: "/",
}
const reload = mock(() => {})
const router = { push: reload }
mock.module("next/navigation", () => ({ useRouter: () => router }))
mock.module("@/components/config-provider", () => ({
  useRuntimeConfig: () => ({
    orgId: "org",
    graphqlEndpoint: "https://dashboard.example.test/graphql",
    wsEndpoint: "",
    appSyncEventsHttpEndpoint: "events.example.test",
  }),
}))
mock.module("../lib/appsync-events/config", () => ({
  getAppSyncEventsRealtimeUrl: () => "wss://events.example.test",
}))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  channel: string | undefined
  constructor(..._args: unknown[]) {
    Socket.instances.push(this)
    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({
        data: JSON.stringify({
          type: "connection_ack",
          connectionTimeoutMs: 300_000,
        }),
      })
    })
  }
  send(data: string) {
    const message: unknown = JSON.parse(data)
    if (
      typeof message === "object" &&
      message !== null &&
      "channel" in message &&
      typeof message.channel === "string"
    )
      this.channel = message.channel
  }
  close() {
    this.readyState = 3
    queueMicrotask(() => this.onclose?.())
  }
}

test("collections mounted during exchange and delayed renewal use committed credentials before auth rerenders", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  Reflect.set(globalThis, "window", {
    location: { host: "dashboard.example.test", reload },
  })
  Reflect.set(globalThis, "document", dom.window.document)
  Reflect.set(globalThis, "WebSocket", Socket)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(document, "visibilityState", { value: "visible" })
  clearReplicationRegistry()
  Socket.instances = []
  reload.mockClear()
  const oldExpiry = Math.floor(Date.now() / 1000) + 60
  const nextExpiry = oldExpiry + 3600
  const token = (exp: number) =>
    `header.${Buffer.from(JSON.stringify({ exp, properties: human })).toString("base64url")}.signature`
  dom.cookieJar.setCookieSync(
    `access_token=${token(oldExpiry)}; Path=/`,
    "https://dashboard.example.test",
  )
  const responseGate = Promise.withResolvers<void>()
  const requestStarted = Promise.withResolvers<void>()
  const cancelGate = Promise.withResolvers<void>()
  const cancelStarted = Promise.withResolvers<void>()
  Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/refresh") {
      dom.cookieJar.setCookieSync(
        `access_token=${token(nextExpiry)}; Path=/`,
        "https://dashboard.example.test",
      )
      requestStarted.resolve()
      await responseGate.promise
      return Response.json({
        success: true,
        expiresAt: nextExpiry,
        cacheScope: getSessionCacheScope(human),
        recipientId: await getRealtimeRecipientId(human, nextExpiry),
      })
    }
    return Response.json({
      data: {
        pullDocuments: {
          documents: [{ id: "permitted", updatedAt: 1, deleted: false }],
          checkpoint: { id: "permitted", updatedAt: 1 },
        },
      },
    })
  })
  type Doc = { id: string; updatedAt: number }
  const db = await createRxDatabase<{
    first: RxCollection<Doc>
    exchange: RxCollection<Doc>
    late: RxCollection<Doc>
  }>({
    name: "refresh-registration-race",
    storage: getRxStorageMemory(),
    multiInstance: false,
  })
  const schema = {
    version: 0,
    primaryKey: "id",
    type: "object",
    properties: {
      id: { type: "string", maxLength: 100 },
      updatedAt: { type: "number" },
    },
    required: ["id", "updatedAt"],
  } satisfies RxJsonSchema<Doc>
  await db.addCollections({
    first: { schema },
    exchange: { schema },
    late: { schema },
  })
  mock.module("../lib/collections/rxdb-provider", () => ({
    useRxDb: () => ({ state: { status: "ready", db } }),
    cleanupRxDb: async () => {},
  }))
  const { createCollectionProvider } = await import(
    "../lib/collections/collection-provider-factory"
  )
  const { AuthProvider, useAuth } = await import("../components/auth-provider")
  const provider = (name: "first" | "exchange" | "late") =>
    createCollectionProvider({
      name,
      getRxCollection: () => db[name],
      pullQueryBuilder: () => ({
        query: "query Pull { pullDocuments }",
        variables: {},
      }),
      deletedField: "deleted",
      appSyncChannel: `/rxdb/collection/${name}`,
      pullResultKey: "pullDocuments",
    })
  const first = provider("first")
  const exchange = provider("exchange")
  const late = provider("late")
  let firstState: ReturnType<typeof first.useCollection> | undefined
  let exchangeState: ReturnType<typeof exchange.useCollection> | undefined
  let lateState: ReturnType<typeof late.useCollection> | undefined
  let contextExpiry = 0
  function First() {
    firstState = first.useCollection()
    contextExpiry = useAuth().expiresAt
    return <input defaultValue="draft" />
  }
  function Exchange() {
    exchangeState = exchange.useCollection()
    return null
  }
  function Late() {
    lateState = late.useCollection()
    return null
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  const render = async (showExchange: boolean, showLate: boolean) => {
    await act(async () => {
      root.render(
        <AuthProvider session={human} expiresAt={oldExpiry}>
          <first.Provider>
            <First />
          </first.Provider>
          {showExchange ? (
            <exchange.Provider>
              <Exchange />
            </exchange.Provider>
          ) : null}
          {showLate ? (
            <late.Provider>
              <Late />
            </late.Provider>
          ) : null}
        </AuthProvider>,
      )
    })
  }
  const waitFor = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ready()) return
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
    throw new Error("Timed out waiting for collection transition")
  }
  try {
    await render(false, false)
    await waitFor(() => firstState?.state.status === "ready")
    if (firstState?.state.status !== "ready")
      throw new Error("First collection not ready")
    const initialCollection = firstState.state.collection
    const initialReplication = firstState.state.replicationState
    const cancel = initialReplication.cancel.bind(initialReplication)
    initialReplication.cancel = async () => {
      cancelStarted.resolve()
      await cancelGate.promise
      return cancel()
    }
    const input = container.querySelector("input")
    if (!input) throw new Error("Form missing")
    input.value = "unsaved edits"
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"))
      await requestStarted.promise
    })
    expect(
      matchesRealtimeSessionToken(token(nextExpiry), human, oldExpiry),
    ).toBe(false)
    await render(true, false)
    expect(Socket.instances).toHaveLength(1)
    expect(contextExpiry).toBe(oldExpiry)
    responseGate.resolve()
    await act(async () => {
      await cancelStarted.promise
    })
    await render(true, true)
    await waitFor(
      () =>
        exchangeState?.state.status === "ready" &&
        lateState?.state.status === "ready",
    )
    if (lateState?.state.status !== "ready")
      throw new Error("Late collection not ready")
    await lateState.state.replicationState.awaitInitialReplication()
    expect((await db.late.findOne("permitted").exec())?.get("id")).toBe(
      "permitted",
    )
    expect(contextExpiry).toBe(oldExpiry)
    const recipient = await getRealtimeRecipientId(human, nextExpiry)
    expect(
      Socket.instances.some(
        (socket) =>
          socket.channel === `/rxdb/collection/late/user/${recipient}`,
      ),
    ).toBe(true)
    cancelGate.resolve()
    await waitFor(() => contextExpiry === nextExpiry)
    expect(firstState.state.status).toBe("ready")
    if (firstState.state.status !== "ready")
      throw new Error("First collection lost")
    expect(firstState.state.collection).toBe(initialCollection)
    expect(firstState.state.replicationState).not.toBe(initialReplication)
    expect(container.querySelector("input")).toBe(input)
    expect(input.value).toBe("unsaved edits")
    expect(reload).not.toHaveBeenCalled()
  } finally {
    responseGate.resolve()
    cancelGate.resolve()
    await act(async () => {
      root.unmount()
    })
    await Promise.all([first.cleanup(), exchange.cleanup(), late.cleanup()])
    await db.remove()
    clearReplicationRegistry()
    Reflect.set(globalThis, "window", previous.window)
    Reflect.set(globalThis, "document", previous.document)
    Reflect.set(globalThis, "fetch", previous.fetch)
    Reflect.set(globalThis, "WebSocket", previous.WebSocket)
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
