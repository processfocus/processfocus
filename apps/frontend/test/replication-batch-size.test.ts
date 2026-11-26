import { Schema } from "effect"
import { type RxCollection, createRxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { AppSyncEventsAdapter } from "../lib/appsync-events/adapter"
import * as appSyncClient from "../lib/appsync-events/client"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { createReplication } from "../lib/collections/replication-factory"
import { expect, spyOn, test } from "bun:test"

type Doc = { id: string; updatedAt: number }
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    variables: Schema.Struct({
      checkpoint: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }),
        ),
      ),
      limit: Schema.Number,
    }),
  }),
)

test.each(["GraphQL", "AppSync Events"])(
  "%s pulls 100-item pages and continues from their checkpoints",
  async (mode) => {
    const documents = Array.from({ length: 205 }, (_, index) => ({
      id: String(index + 1).padStart(3, "0"),
      updatedAt: index + 1,
      deleted: false,
    }))
    const requests: Array<{ limit: number; after: number }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { variables } = decodeRequest(await request.json())
        const after = variables.checkpoint?.updatedAt ?? 0
        requests.push({ limit: variables.limit, after })
        const page = documents
          .filter((doc) => doc.updatedAt > after)
          .slice(0, variables.limit)
        const last = page.at(-1)
        return Response.json({
          data: {
            pull: {
              documents: page,
              checkpoint: last
                ? { id: last.id, updatedAt: last.updatedAt }
                : variables.checkpoint,
            },
          },
        })
      },
    })
    const db = await createRxDatabase<{ docs: RxCollection<Doc> }>({
      name: `batch-${crypto.randomUUID()}`,
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
    const session = {
      userId: "reader",
      email: "reader@example.test",
      roles: ["/Employee"],
      orgUnitId: "org",
      orgUnitPath: "/",
    }
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const token = `header.${Buffer.from(
      JSON.stringify({ properties: session, exp: expiry }),
    ).toString("base64url")}.signature`
    // AWS pub/sub is external; keep the actual pull handler and RxDB engine.
    const connect = spyOn(
      AppSyncEventsAdapter.prototype,
      "connect",
    ).mockResolvedValue()
    const cookie = spyOn(appSyncClient, "getCookie").mockReturnValue(token)
    let replication:
      | Awaited<ReturnType<typeof createReplication<Doc>>>
      | undefined
    try {
      replication = await createReplication({
        collection: db.docs,
        cacheScope: getSessionCacheScope(session),
        session,
        accessTokenExpiresAt: expiry,
        recipientId: await getRealtimeRecipientId(session, expiry),
        isCurrent: () => true,
        graphqlEndpoint: server.url.href,
        wsEndpoint: server.url.href.replace("http:", "ws:"),
        ...(mode === "AppSync Events"
          ? { httpHost: "events.example.test" }
          : {}),
        replicationIdentifier: "batch-size",
        deletedField: "deleted",
        appSyncChannel: "/rxdb/collection/todo",
        pullResultKey: "pull",
        pullQueryBuilder: (checkpoint, limit) => ({
          query:
            "query Pull($checkpoint: PullCheckpoint, $limit: Int!) { pull(checkpoint: $checkpoint, limit: $limit) { documents { id updatedAt deleted } checkpoint { id updatedAt } } }",
          variables: { checkpoint, limit },
        }),
        pushResultKey: "push",
        pushQueryBuilder: (rows) => ({
          query: "mutation { push }",
          variables: { rows },
        }),
      })
      await replication.awaitInitialReplication()
      await replication.awaitInSync()
      expect(requests).toEqual([
        { limit: 100, after: 0 },
        { limit: 100, after: 100 },
        { limit: 100, after: 200 },
      ])
      expect((await db.docs.find().exec()).map((doc) => doc.id).sort()).toEqual(
        documents.map((doc) => doc.id),
      )
      expect(replication.push?.batchSize).toBe(5)
    } finally {
      await replication?.cancel()
      await db.remove()
      server.stop(true)
      cookie.mockRestore()
      connect.mockRestore()
    }
  },
)
