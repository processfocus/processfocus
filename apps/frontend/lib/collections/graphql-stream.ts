import type { RxReplicationPullStreamItem } from "rxdb/plugins/core"
import {
  GRAPHQL_WEBSOCKET_BY_URL,
  getGraphQLWebSocket,
  removeGraphQLWebSocketRef,
} from "rxdb/plugins/replication-graphql"
import { Subject } from "rxjs"
import type { PullCheckpoint } from "../generated/gql/graphql"
import type { StreamQueryBuilder } from "./replication-factory"

const streams = new Set<{
  cacheScope: string
  url: string
  stop: () => void
  start: () => void
}>()

/** Only call after a successful refresh has confirmed the same cache scope. */
export function reconnectGraphQLStreams(cacheScope: string): void {
  const current = [...streams].filter(
    (stream) => stream.cacheScope === cacheScope,
  )
  // Release every reference before reacquiring: authentication belongs to the
  // upgrade request, so reusing even an idle socket would reuse its old cookie.
  for (const stream of current) stream.stop()
  for (const stream of current) {
    if (GRAPHQL_WEBSOCKET_BY_URL.has(stream.url)) {
      throw new Error(
        "Cannot refresh a GraphQL socket shared with another session",
      )
    }
  }
  for (const stream of current) stream.start()
}

export function createGraphQLStream<TDoc>({
  cacheScope,
  url,
  queryBuilder,
  onError,
  retryWait,
}: {
  cacheScope: string
  url: string
  queryBuilder: StreamQueryBuilder
  onError: (error: unknown) => void
  retryWait?: (retries: number) => Promise<void>
}) {
  // A subscription may end while the tab is hidden. Keep RxDB's stream alive;
  // only a verified same-scope refresh may replace the ended subscription.
  const events = new Subject<
    RxReplicationPullStreamItem<TDoc, PullCheckpoint>
  >()
  let dispose: (() => void) | undefined
  let closed = false
  const stream = {
    cacheScope,
    url,
    stop() {
      dispose?.()
      dispose = undefined
    },
    start() {
      if (closed || dispose) return
      for (const other of streams) {
        if (other.url === url && other.cacheScope !== cacheScope) {
          throw new Error("Cannot share a GraphQL socket across sessions")
        }
      }
      const query = queryBuilder()
      const client = getGraphQLWebSocket(url, undefined, {
        connectionParams: { sessionCacheScope: cacheScope },
        ...(retryWait === undefined ? {} : { retryWait }),
      })
      let active = true
      const removeConnected = client.on("connected", () => {
        if (active) events.next("RESYNC")
      })
      const unsubscribe = client.subscribe<
        Record<string, RxReplicationPullStreamItem<TDoc, PullCheckpoint>>
      >(query, {
        next(response) {
          if (!active) return
          if (!response.data || response.errors?.length) {
            active = false
            onError(response.errors ?? new Error("Missing GraphQL stream data"))
            return
          }
          const value = Object.values(response.data)[0]
          if (value) events.next(value)
        },
        error(error) {
          if (!active) return
          active = false
          onError(error)
        },
        complete() {
          active = false
        },
      })
      dispose = () => {
        active = false
        unsubscribe()
        removeConnected()
        removeGraphQLWebSocketRef(url)
      }
    },
  }
  return {
    stream$: events.asObservable(),
    start() {
      if (closed) return
      streams.add(stream)
      stream.start()
    },
    close() {
      closed = true
      streams.delete(stream)
      stream.stop()
      events.complete()
    },
  }
}
