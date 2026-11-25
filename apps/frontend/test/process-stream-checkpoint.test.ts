import type { ServerWebSocket } from "bun"
import { Schema } from "effect"
import { type RxCollection, createRxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { filter, firstValueFrom, timeout } from "rxjs"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { createReplication } from "../lib/collections/replication-factory"
import { expect, it } from "bun:test"

type Doc = { id: string; updatedAt: number }
const checkpointSchema = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.Number,
})
const requestSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    variables: Schema.Struct({
      checkpoint: Schema.optional(Schema.NullOr(checkpointSchema)),
    }),
  }),
)
const frameSchema = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.String) }),
  ),
)

it("resyncs unordered Process notifications without skipping other changes at the same revision", async () => {
  let revision = 1
  let socket: ServerWebSocket<undefined> | undefined
  let operationId = ""
  const subscribed = Promise.withResolvers<void>()
  const caughtUp = Promise.withResolvers<void>()
  const checkpoints: Array<
    { id: string; updatedAt: number } | null | undefined
  > = []
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return
      const {
        variables: { checkpoint },
      } = requestSchema(await request.json())
      checkpoints.push(checkpoint)
      if (checkpoint?.updatedAt === 1) caughtUp.resolve()
      const documents =
        checkpoint && checkpoint.updatedAt >= revision
          ? []
          : ["a", "z"].map((id) => ({
              id,
              updatedAt: revision,
              deleted: revision === 2,
            }))
      return Response.json({
        data: {
          pull: { documents, checkpoint: { id: "z", updatedAt: revision } },
        },
      })
    },
    websocket: {
      message(ws, raw) {
        const frame = frameSchema(String(raw))
        if (frame.type === "connection_init")
          ws.send(JSON.stringify({ type: "connection_ack" }))
        if (frame.type === "subscribe") {
          socket = ws
          operationId = frame.id ?? ""
          subscribed.resolve()
        }
      },
    },
  })
  const db = await createRxDatabase<{ docs: RxCollection<Doc> }>({
    name: `process-stream-${crypto.randomUUID()}`,
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
          id: { type: "string", maxLength: 41 },
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
  const replication = await createReplication({
    collection: db.docs,
    cacheScope: getSessionCacheScope(session),
    session,
    accessTokenExpiresAt: expiry,
    recipientId: await getRealtimeRecipientId(session, expiry),
    isCurrent: () => true,
    graphqlEndpoint: server.url.href,
    wsEndpoint: server.url.href.replace("http:", "ws:"),
    replicationIdentifier: "process-checkpoint",
    streamMode: "resync",
    deletedField: "deleted",
    appSyncChannel: "",
    pullResultKey: "pull",
    pullQueryBuilder: (checkpoint) => ({
      query:
        "query Pull($checkpoint: PullCheckpoint) { pull { documents { id updatedAt deleted } checkpoint { id updatedAt } } }",
      variables: { checkpoint },
    }),
    pullStreamQueryBuilder: () => ({
      query:
        "subscription { stream { documents { id updatedAt deleted } checkpoint { id updatedAt } } }",
      variables: {},
    }),
  })
  try {
    await replication.awaitInitialReplication()
    await subscribed.promise
    await caughtUp.promise
    await replication.awaitInSync()
    expect(await db.docs.find().exec()).toHaveLength(2)
    revision = 2
    // Only the higher-ID event arrives; the lower-ID event is lost. Applying
    // this checkpoint directly leaves "a" cached forever after reconnect.
    socket?.send(
      JSON.stringify({
        id: operationId,
        type: "next",
        payload: {
          data: {
            stream: {
              documents: [{ id: "z", updatedAt: 2, deleted: true }],
              checkpoint: { id: "z", updatedAt: 2 },
            },
          },
        },
      }),
    )
    const rows = await firstValueFrom(
      db.docs.find().$.pipe(
        filter((rows) => rows.length === 0),
        timeout(1500),
      ),
    )
    expect(rows).toEqual([])
    expect(checkpoints).toContainEqual({ id: "z", updatedAt: 1 })
  } finally {
    await replication.cancel()
    await db.remove()
    server.stop(true)
  }
})
