import type { ServerWebSocket } from "bun"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { type RxCollection, createRxDatabase } from "rxdb"
import { GRAPHQL_WEBSOCKET_BY_URL } from "rxdb/plugins/replication-graphql"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { BehaviorSubject, filter, firstValueFrom, timeout } from "rxjs"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import {
  createGraphQLStream,
  reconnectGraphQLStreams,
} from "../lib/collections/graphql-stream"
import { createReplication } from "../lib/collections/replication-factory"
import {
  clearReplicationRegistry,
  refreshReplicationCredentials,
} from "../lib/collections/replication-registry"
import { expect, mock, test } from "bun:test"

const router = { push: mock(() => undefined) }
mock.module("next/navigation", () => ({ useRouter: () => router }))
const { TokenRefreshScheduler } = await import(
  "../components/token-refresh-scheduler"
)

type Document = { id: string; updatedAt: number }
const session = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Worker"],
  orgUnitId: "org",
  orgUnitPath: "/",
  delegation: {
    id: "agent",
    generationId: "one",
    name: "Agent",
    expiresAt: 2_000_000_000_000,
  },
}
const cacheScope = getSessionCacheScope(session)
const onRefresh = (expiresAt: number) =>
  refreshReplicationCredentials(expiresAt, cacheScope)
const onInvalidSession = () => undefined
const waitForCount = (source: BehaviorSubject<number>, count: number) =>
  firstValueFrom(
    source.pipe(
      filter((value) => value >= count),
      timeout(3000),
    ),
  )

test.each(["complete", "error"])(
  "delayed same-scope refresh resumes real RxDB delivery after terminal %s",
  async (terminal) => {
    const dom = new JSDOM("", { url: "https://dashboard.example.test" })
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT
    const originalFetch = globalThis.fetch
    Reflect.set(globalThis, "window", dom.window)
    Reflect.set(globalThis, "document", dom.window.document)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let visibility = "hidden"
    Object.defineProperty(document, "visibilityState", {
      get: () => visibility,
    })
    const root = createRoot(document.createElement("div"))
    let finishRefresh: (response: Response) => void = () => undefined
    const refreshRequest = mock(
      () =>
        new Promise<Response>((resolve) => {
          finishRefresh = resolve
        }),
    )
    Reflect.set(
      globalThis,
      "fetch",
      (input: RequestInfo | URL, init?: RequestInit) =>
        input === "/api/auth/refresh"
          ? refreshRequest()
          : originalFetch(input, init),
    )
    const subscriptions = new BehaviorSubject(0)
    const terminations = new BehaviorSubject(0)
    const denied = new BehaviorSubject(0)
    const sockets = new Map<ServerWebSocket<{ upgrade: number }>, Set<string>>()
    let upgrades = 0
    let authorized = true
    const checkpoints: unknown[] = []
    const serverDocuments: Array<Document & { _deleted: boolean }> = []
    const server = Bun.serve<{ upgrade: number }>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        if (request.headers.get("upgrade") === "websocket") {
          if (server.upgrade(request, { data: { upgrade: ++upgrades } })) return
          return new Response(null, { status: 400 })
        }
        const body = await request.json()
        checkpoints.push(body.variables.checkpoint)
        return Response.json({
          data: {
            pull: {
              documents: authorized
                ? serverDocuments.filter(
                    (doc) =>
                      doc.updatedAt >
                      (body.variables.checkpoint?.updatedAt ?? 0),
                  )
                : [],
              checkpoint:
                authorized && serverDocuments.length
                  ? {
                      id: serverDocuments.at(-1)?.id,
                      updatedAt: serverDocuments.at(-1)?.updatedAt,
                    }
                  : (body.variables.checkpoint ?? { id: "", updatedAt: 0 }),
            },
          },
        })
      },
      websocket: {
        open(socket) {
          sockets.set(socket, new Set())
        },
        message(socket, raw) {
          const message = JSON.parse(String(raw))
          if (message.type === "connection_init") {
            socket.send(JSON.stringify({ type: "connection_ack" }))
          } else if (message.type === "subscribe") {
            if (!authorized) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  id: message.id,
                  payload: [{ message: "Revoked generation" }],
                }),
              )
              denied.next(denied.value + 1)
              return
            }
            sockets.get(socket)?.add(message.id)
            subscriptions.next(subscriptions.value + 1)
          } else if (message.type === "complete") {
            sockets.get(socket)?.delete(message.id)
          }
        },
        close(socket) {
          sockets.delete(socket)
        },
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}/graphql`
    const url = endpoint.replace("http:", "ws:")
    const db = await createRxDatabase<{
      first: RxCollection<Document>
      second: RxCollection<Document>
    }>({
      name: `refresh-${terminal}`,
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
    }
    await db.addCollections({ first: { schema }, second: { schema } })
    const accessTokenExpiresAt = Math.floor(Date.now() / 1000) + 60
    const recipientId = await getRealtimeRecipientId(
      session,
      accessTokenExpiresAt,
    )
    const replications = await Promise.all(
      [db.first, db.second].map((collection) =>
        createReplication({
          collection,
          cacheScope,
          session,
          accessTokenExpiresAt,
          recipientId,
          isCurrent: () => true,
          graphqlEndpoint: endpoint,
          wsEndpoint: url,
          replicationIdentifier: collection.name,
          deletedField: "_deleted",
          appSyncChannel: "",
          pullResultKey: "pull",
          pullQueryBuilder: (checkpoint) => ({
            query: "query Pull { pull { documents { id updatedAt } } }",
            variables: { checkpoint },
          }),
          pullStreamQueryBuilder: () => ({
            query:
              "subscription Stream { stream { documents { id updatedAt } } }",
            variables: {},
          }),
          graphqlWsRetryWait: async () => {},
        }),
      ),
    )
    const emit = (id: string, updatedAt: number) => {
      serverDocuments.push({ id, updatedAt, _deleted: false })
      for (const [socket, ids] of sockets) {
        for (const subscriptionId of ids) {
          socket.send(
            JSON.stringify({
              type: "next",
              id: subscriptionId,
              payload: {
                data: {
                  stream: {
                    documents: [{ id, updatedAt, _deleted: false }],
                    checkpoint: { id, updatedAt },
                  },
                },
              },
            }),
          )
        }
      }
    }
    const received = (id: string) =>
      Promise.all(
        [db.first, db.second].map((collection) =>
          firstValueFrom(
            collection.findOne(id).$.pipe(
              filter((doc) => doc !== null),
              timeout(3000),
            ),
          ),
        ),
      )
    try {
      await act(async () => {
        root.render(
          <TokenRefreshScheduler
            initialExpiresAt={0}
            session={session}
            onRefresh={onRefresh}
            onInvalidSession={onInvalidSession}
          />,
        )
        document.dispatchEvent(new dom.window.Event("visibilitychange"))
      })
      await waitForCount(subscriptions, 2)
      expect(upgrades).toBe(1)
      const otherSession = createGraphQLStream<Document>({
        cacheScope: "human",
        url,
        queryBuilder: () => ({
          query: "subscription { stream }",
          variables: {},
        }),
        onError: () => undefined,
      })
      try {
        expect(() => otherSession.start()).toThrow(
          "Cannot share a GraphQL socket across sessions",
        )
      } finally {
        otherSession.close()
      }
      const originalStates = replications.map(
        (replication) => replication.metaInstance,
      )
      const before = received("before")
      emit("before", 1)
      await before
      await Promise.all(
        replications.map((replication) => replication.awaitInSync()),
      )

      const client = GRAPHQL_WEBSOCKET_BY_URL.get(url)?.socket
      const removeMessage = client?.on("message", (message) => {
        if (message.type === "complete" || message.type === "error")
          terminations.next(terminations.value + 1)
      })
      for (const [socket, ids] of sockets) {
        for (const id of ids)
          socket.send(
            JSON.stringify({
              type: terminal,
              id,
              ...(terminal === "error"
                ? {
                    payload: [
                      { message: "Access token expired while tab hidden" },
                    ],
                  }
                : {}),
            }),
          )
        ids.clear()
      }
      await waitForCount(terminations, 2)
      removeMessage?.()
      await Bun.sleep(0)
      // No timer or automatic subscription retry can revive a terminal stream.
      emit("while-hidden", 2)
      reconnectGraphQLStreams("human-or-other-generation")
      expect(subscriptions.value).toBe(2)
      expect(await db.first.findOne("while-hidden").exec()).toBeNull()
      expect(refreshRequest).not.toHaveBeenCalled()

      // Return to a visible tab after expiry; no restart until refresh resolves.
      visibility = "visible"
      await act(async () => {
        document.dispatchEvent(new dom.window.Event("visibilitychange"))
      })
      expect(refreshRequest).toHaveBeenCalledTimes(1)
      expect(upgrades).toBe(1)
      await act(async () => {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600
        finishRefresh(
          Response.json({
            success: true,
            cacheScope,
            expiresAt,
            recipientId: await getRealtimeRecipientId(session, expiresAt),
          }),
        )
      })
      await waitForCount(subscriptions, 4)
      expect(upgrades).toBe(2)
      expect(GRAPHQL_WEBSOCKET_BY_URL.get(url)?.refCount).toBe(2)
      await received("while-hidden")
      const after = received("after")
      emit("after", 3)
      await after
      await Promise.all(
        replications.map((replication) => replication.awaitInSync()),
      )
      expect(
        replications.map((replication) => replication.metaInstance),
      ).toEqual(originalStates)
      expect(await db.first.find().exec()).toHaveLength(3)
      expect(checkpoints).toContainEqual({ id: "before", updatedAt: 1 })

      // Cancelling one collection releases only its subscription. Refresh must
      // neither resurrect it nor accumulate references/listeners on the survivor.
      await replications[0]?.cancel()
      reconnectGraphQLStreams(cacheScope)
      await waitForCount(subscriptions, 5)
      expect(GRAPHQL_WEBSOCKET_BY_URL.get(url)?.refCount).toBe(1)
      const survivor = firstValueFrom(
        db.second.findOne("survivor").$.pipe(
          filter((doc) => doc !== null),
          timeout(3000),
        ),
      )
      emit("survivor", 4)
      await survivor
      expect(await db.first.findOne("survivor").exec()).toBeNull()

      // Revalidation at the new connection still rejects revocation racing refresh.
      authorized = false
      reconnectGraphQLStreams(cacheScope)
      await waitForCount(denied, 1)
      emit("unauthorized", 5)
      expect(await db.first.findOne("unauthorized").exec()).toBeNull()
      await Promise.all(replications.map((replication) => replication.cancel()))
      reconnectGraphQLStreams(cacheScope)
      expect(GRAPHQL_WEBSOCKET_BY_URL.has(url)).toBe(false)
      expect(upgrades).toBe(4)
    } finally {
      await act(async () => root.unmount())
      await Promise.all(replications.map((replication) => replication.cancel()))
      await db.close()
      clearReplicationRegistry()
      await server.stop(true)
      subscriptions.complete()
      terminations.complete()
      denied.complete()
      globalThis.fetch = originalFetch
      Reflect.set(globalThis, "window", previousWindow)
      Reflect.set(globalThis, "document", previousDocument)
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct
      dom.window.close()
    }
  },
)

test("cleanup racing initial startup cannot register or revive the stream", () => {
  const url = "ws://127.0.0.1:1/not-opened"
  const stream = createGraphQLStream<Document>({
    cacheScope: "logged-out",
    url,
    queryBuilder: () => ({ query: "subscription { stream }", variables: {} }),
    onError: () => undefined,
  })
  const completed = mock(() => undefined)
  stream.stream$.subscribe({ complete: completed })
  stream.close()
  stream.start()
  reconnectGraphQLStreams("logged-out")
  expect(completed).toHaveBeenCalledTimes(1)
  expect(GRAPHQL_WEBSOCKET_BY_URL.has(url)).toBe(false)
})
