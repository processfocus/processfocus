import type { ServerWebSocket } from "bun"
import { type RxCollection, createRxDatabase } from "rxdb"
import { GRAPHQL_WEBSOCKET_BY_URL } from "rxdb/plugins/replication-graphql"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { BehaviorSubject, filter, firstValueFrom, timeout } from "rxjs"
import type { ProviderUserSession } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { assertGraphqlSessionBinding } from "../../../packages/graphql-api/src/lib/session-binding"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { createReplication } from "../lib/collections/replication-factory"
import { expect, test } from "bun:test"

const delegated: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/Worker"],
  delegationRoleSelection: ["/Worker"],
  delegation: {
    id: "delegate",
    generationId: "one",
    name: "agent",
    expiresAt: 2_000_000_000_000,
  },
}
const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/Manager", "/Worker"],
}
type Doc = { id: string; updatedAt: number }
type Connection = { session: ProviderUserSession; params?: unknown }

test.each([
  { name: "human cookie", nextSession: human, blocked: true },
  {
    name: "broader roles",
    blocked: true,
    nextSession: { ...delegated, roles: ["/Manager", "/Worker"] },
  },
  {
    name: "replacement generation",
    blocked: true,
    nextSession: {
      ...delegated,
      delegation: { ...delegated.delegation!, generationId: "two" },
    },
  },
  {
    name: "same-scope credential rotation",
    blocked: false,
    nextSession: {
      ...delegated,
      delegation: { ...delegated.delegation!, name: "renamed" },
    },
  },
])(
  "automatic WS retry preserves the cache binding after $name",
  async ({ nextSession, blocked }) => {
    const cacheScope = getSessionCacheScope(delegated)
    // This fixture represents the authenticated session obtained from each request's
    // cookie. JWT verification is upstream of the real binding assertion under test.
    let cookieSession = delegated
    const connections = new Set<ServerWebSocket<Connection>>()
    const accepted = new BehaviorSubject(0)
    const denied = new BehaviorSubject(0)
    const httpDenied = new BehaviorSubject(0)
    const paramsSeen: unknown[] = []
    let httpBindingSeen: string | null = null
    const httpRequests: Request[] = []
    const waitFor = (count: BehaviorSubject<number>, minimum: number) =>
      firstValueFrom(
        count.pipe(
          filter((value) => value >= minimum),
          timeout(8000),
        ),
      )
    const server = Bun.serve<Connection>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        if (request.headers.get("upgrade") === "websocket") {
          if (server.upgrade(request, { data: { session: cookieSession } }))
            return
          return new Response(null, { status: 400 })
        }
        httpBindingSeen = request.headers.get("x-pf-session-cache-scope")
        httpRequests.push(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
        )
        try {
          assertGraphqlSessionBinding({ request }, cookieSession)
        } catch (error) {
          httpDenied.next(httpDenied.value + 1)
          return Response.json({ errors: [{ message: String(error) }] })
        }
        return Response.json({
          data: {
            pull: {
              documents:
                getSessionCacheScope(cookieSession) === cacheScope
                  ? []
                  : [{ id: "broader-http", updatedAt: 2, _deleted: false }],
              checkpoint: { id: "", updatedAt: 0 },
            },
          },
        })
      },
      websocket: {
        open(socket) {
          connections.add(socket)
        },
        close(socket) {
          connections.delete(socket)
        },
        async message(socket, raw): Promise<void> {
          const message = JSON.parse(String(raw))
          if (message.type === "connection_init") {
            socket.data.params = message.payload
            paramsSeen.push(message.payload)
            socket.send(JSON.stringify({ type: "connection_ack" }))
          } else if (message.type === "subscribe") {
            try {
              assertGraphqlSessionBinding(
                { connectionParams: socket.data.params },
                socket.data.session,
              )
            } catch (error) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  id: message.id,
                  payload: [{ message: String(error) }],
                }),
              )
              denied.next(denied.value + 1)
              return
            }
            accepted.next(accepted.value + 1)
            const id =
              getSessionCacheScope(socket.data.session) !== cacheScope
                ? "broader-ws"
                : socket.data.session === delegated
                  ? "restricted"
                  : "resumed"
            // The connection ack triggers RESYNC. RxDB may discard stream events
            // queued before that pull, which this WS-only fixture answers empty.
            await replication.awaitInSync()
            socket.send(
              JSON.stringify({
                type: "next",
                id: message.id,
                payload: {
                  data: {
                    stream: {
                      documents: [{ id, updatedAt: 1, _deleted: false }],
                      checkpoint: { id, updatedAt: 1 },
                    },
                  },
                },
              }),
            )
          }
        },
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}/graphql`
    const url = endpoint.replace("http:", "ws:")
    const db = await createRxDatabase<{ docs: RxCollection<Doc> }>({
      name: `binding-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
      multiInstance: false,
    })
    await db.addCollections({
      docs: {
        schema: {
          version: 0,
          primaryKey: "id",
          type: "object",
          properties: {
            id: { type: "string", maxLength: 100 },
            updatedAt: { type: "number" },
          },
          required: ["id", "updatedAt"],
        },
      },
    })
    const accessTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
    const replication = await createReplication({
      cacheScope,
      session: delegated,
      accessTokenExpiresAt,
      recipientId: await getRealtimeRecipientId(
        delegated,
        accessTokenExpiresAt,
      ),
      isCurrent: () => true,
      collection: db.docs,
      graphqlEndpoint: endpoint,
      wsEndpoint: url,
      replicationIdentifier: "binding",
      deletedField: "_deleted",
      appSyncChannel: "",
      pullResultKey: "pull",
      pullQueryBuilder: () => ({ query: "query { pull }", variables: {} }),
      pullStreamQueryBuilder: () => ({
        query: "subscription { stream }",
        variables: {},
      }),
      graphqlWsRetryWait: async () => {},
    })
    try {
      await waitFor(accepted, 1)
      await firstValueFrom(
        db.docs.findOne("restricted").$.pipe(
          filter((doc) => doc !== null),
          timeout(3000),
        ),
      )
      expect(paramsSeen).toEqual([{ sessionCacheScope: cacheScope }])
      expect(httpBindingSeen).toBe(encodeURIComponent(cacheScope))
      expect(httpRequests[0]?.headers.get("content-type")).toBe(
        "application/json",
      )

      if (!("customFetch" in replication) || !replication.customFetch) {
        throw new Error("Expected the real GraphQL replication fetch wrapper")
      }
      const request = new Request(`${endpoint}?probe=request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request": "inherited",
        },
        body: JSON.stringify({ query: "query { pull }" }),
      })
      await replication.customFetch(request)
      const inherited = httpRequests.find((value) =>
        value.url.endsWith("?probe=request"),
      )
      expect(inherited?.headers.get("content-type")).toBe("application/json")
      expect(inherited?.headers.get("x-request")).toBe("inherited")
      expect(inherited?.headers.get("x-pf-session-cache-scope")).toBe(
        encodeURIComponent(cacheScope),
      )
      expect(inherited?.method).toBe("POST")
      expect(await inherited?.json()).toEqual({ query: "query { pull }" })

      await replication.customFetch(
        new Request(`${endpoint}?probe=options`, {
          method: "POST",
          headers: { "x-request": "replaced" },
          body: "original",
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-option": "override",
            "x-pf-session-cache-scope": "cannot-override",
          },
          body: JSON.stringify({ query: "query { overridden }" }),
        },
      )
      const overridden = httpRequests.find((value) =>
        value.url.endsWith("?probe=options"),
      )
      expect(overridden?.headers.get("content-type")).toBe("application/json")
      expect(overridden?.headers.get("x-request")).toBeNull()
      expect(overridden?.headers.get("x-option")).toBe("override")
      expect(overridden?.headers.get("x-pf-session-cache-scope")).toBe(
        encodeURIComponent(cacheScope),
      )
      expect(await overridden?.json()).toEqual({
        query: "query { overridden }",
      })

      // No application refresh callback. The network drops and graphql-ws retries
      // with cookies changed by another tab between the original auth and upgrade.
      cookieSession = nextSession
      for (const socket of connections) socket.close(1012, "Network restart")
      if (blocked) {
        await waitFor(denied, 1)
        // connection_ack also triggers RxDB RESYNC; bind that HTTP request too.
        await waitFor(httpDenied, 1)
      } else {
        await waitFor(accepted, 2)
        await firstValueFrom(
          db.docs.findOne("resumed").$.pipe(
            filter((doc) => doc !== null),
            timeout(3000),
          ),
        )
        expect(denied.value).toBe(0)
        expect(httpDenied.value).toBe(0)
      }
      expect(paramsSeen).toEqual([
        { sessionCacheScope: cacheScope },
        { sessionCacheScope: cacheScope },
      ])
      expect(accepted.value).toBe(blocked ? 1 : 2)
      expect(await db.docs.findOne("broader-ws").exec()).toBeNull()
      expect(await db.docs.findOne("broader-http").exec()).toBeNull()
      expect(await db.docs.find().exec()).toHaveLength(blocked ? 1 : 2)
    } finally {
      await replication.cancel()
      expect(GRAPHQL_WEBSOCKET_BY_URL.has(url)).toBe(false)
      await db.close()
      await server.stop(true)
      accepted.complete()
      denied.complete()
      httpDenied.complete()
    }
  },
  15000,
)
