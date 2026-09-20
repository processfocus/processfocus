import type {
  ReplicationOptions,
  RxCollection,
  SyncOptionsGraphQL,
} from "rxdb/plugins/core"
import { newRxError } from "rxdb/plugins/core"
import { replicateRxCollection } from "rxdb/plugins/replication"
import { replicateGraphQL } from "rxdb/plugins/replication-graphql"
import type { Session } from "@pf/auth-session"
import { isRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { AppSyncEventsAdapter } from "../appsync-events/adapter"
import { getCookie } from "../appsync-events/client"
import { matchesRealtimeSessionToken } from "../auth/realtime-session-token"
import type { PullCheckpoint } from "../generated/gql/graphql"
import { createGraphQLStream } from "./graphql-stream"

/**
 * Base type for all RxDB documents - must have id and updatedAt
 */
interface RxDbDocumentBase {
  id: string
  updatedAt: number
}

export type PullQueryBuilder = (
  checkpoint: PullCheckpoint | undefined,
  limit: number,
) => {
  query: string
  operationName?: string
  variables: unknown
}

export type PushQueryBuilder = (rows: unknown) => {
  query: string
  operationName?: string
  variables: unknown
}

export type StreamQueryBuilder = () => {
  query: string
  operationName?: string
  variables: Record<string, unknown>
}

interface BaseReplicationConfig<TDoc extends RxDbDocumentBase> {
  cacheScope: string
  collection: RxCollection<TDoc>
  pullQueryBuilder: PullQueryBuilder
  /**
   * Stream query builder for real-time subscriptions. Optional - if not provided,
   * replication will use polling only.
   */
  pullStreamQueryBuilder?: StreamQueryBuilder
  deletedField: string

  /**
   * Unique identifier for this replication (e.g., "draft-process-execution", "process")
   */
  replicationIdentifier: string

  /**
   * Key to extract pull result from GraphQL response (e.g., "pullDraftProcessExecution", "pullProcess")
   */
  pullResultKey: string

  /**
   * GraphQL endpoint URL
   */
  graphqlEndpoint: string

  /**
   * WebSocket endpoint URL for GraphQL subscriptions
   */
  wsEndpoint: string

  /**
   * Required for AppSync Events. Base channel path for real-time updates.
   * e.g., "/rxdb/collection/todo"
   * The exact recipient is appended as "/user/{recipientId}".
   */
  appSyncChannel: string

  /**
   * AppSync Events HTTP host. If provided, AppSync Events mode is used.
   */
  httpHost?: string

  recipientId: string | undefined
  session: Session
  accessTokenExpiresAt: number
  isCurrent: () => boolean
  /** graphql-ws reconnect backoff. Defaults to the library randomised delay. */
  graphqlWsRetryWait?: (retries: number) => Promise<void>
}

/**
 * The legacy /user segment carries an exact recipient, never a shared fallback.
 */
export const buildChannelPath = (
  baseChannel: string,
  recipientId: string | undefined,
): string => {
  if (!recipientId || !isRealtimeRecipientId(recipientId)) {
    throw new Error("A valid realtime recipient is required")
  }
  return `${baseChannel}/user/${recipientId}`
}

interface PushReplicationConfig<TDoc extends RxDbDocumentBase>
  extends BaseReplicationConfig<TDoc> {
  pushQueryBuilder: PushQueryBuilder
  /**
   * Key to extract push result from GraphQL response (e.g., "pushDraftProcessExecution")
   */
  pushResultKey: string
}

interface PullOnlyReplicationConfig<TDoc extends RxDbDocumentBase>
  extends BaseReplicationConfig<TDoc> {
  pushQueryBuilder?: undefined
  pushResultKey?: undefined
}

export type ReplicationConfig<TDoc extends RxDbDocumentBase> =
  | PushReplicationConfig<TDoc>
  | PullOnlyReplicationConfig<TDoc>

/**
 * Creates RxDB replication using standard GraphQL with WebSocket subscriptions.
 * Used with local Yoga GraphQL server that supports graphql-ws protocol.
 */
const createGraphQLReplication = <TDoc extends RxDbDocumentBase>(
  config: ReplicationConfig<TDoc>,
) => {
  const pullConfig: NonNullable<
    SyncOptionsGraphQL<TDoc, PullCheckpoint>["pull"]
  > = {
    queryBuilder: config.pullQueryBuilder,
    batchSize: 50,
  }

  const baseConfig: SyncOptionsGraphQL<TDoc, PullCheckpoint> = {
    collection: config.collection,
    url: {
      http: config.graphqlEndpoint,
    },
    pull: pullConfig,
    replicationIdentifier: config.replicationIdentifier,
    deletedField: config.deletedField,
    live: true,
    retryTime: 10000,
    // Replication is auth/role-scoped, but browser leadership is origin-wide.
    // A stale background tab can otherwise become the only live subscriber and
    // leave the visible tab with an out-of-date local collection.
    waitForLeadership: false,
    autoStart: false,
    fetch: async (url, options) => {
      if (!config.isCurrent()) throw new Error("Replication authority changed")
      const headers = new Headers(
        options?.headers ?? (url instanceof Request ? url.headers : undefined),
      )
      headers.set(
        "x-pf-session-cache-scope",
        encodeURIComponent(config.cacheScope),
      )
      const response = await fetch(url, {
        ...options,
        headers,
        credentials: "include",
      })
      if (!config.isCurrent()) throw new Error("Replication authority changed")
      return response
    },
  }

  const replication = config.pushQueryBuilder
    ? replicateGraphQL<TDoc, PullCheckpoint>({
        ...baseConfig,
        push: {
          queryBuilder: config.pushQueryBuilder,
          batchSize: 5,
        },
      })
    : replicateGraphQL<TDoc, PullCheckpoint>(baseConfig)

  const reportStreamError = (error: unknown) => {
    replication.subjects.error.next(
      newRxError("RC_STREAM", {
        errors: [
          {
            name: error instanceof Error ? error.name : "GraphQLStreamError",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        data: error,
      }),
    )
  }
  const stream = config.pullStreamQueryBuilder
    ? createGraphQLStream<TDoc>({
        cacheScope: config.cacheScope,
        url: config.wsEndpoint,
        queryBuilder: config.pullStreamQueryBuilder,
        onError: reportStreamError,
        ...(config.graphqlWsRetryWait === undefined
          ? {}
          : { retryWait: config.graphqlWsRetryWait }),
      })
    : undefined
  // Own the stream subscription lifecycle without replacing the RxDB state,
  // documents, or checkpoints when graphql-ws sends a terminal frame.
  if (stream && replication.pull) replication.pull.stream$ = stream.stream$
  const cancel = replication.cancel.bind(replication)
  replication.cancel = () => {
    stream?.close()
    return cancel()
  }
  void replication
    .start()
    .then(() => stream?.start())
    .catch((error: unknown) => {
      stream?.close()
      reportStreamError(error)
    })
  return replication
}

/**
 * Creates RxDB replication using AppSync Events for real-time updates.
 * Used with AWS Lambda GraphQL server + AppSync Events pub/sub.
 */
const createAppSyncEventsReplication = async <TDoc extends RxDbDocumentBase>(
  config: ReplicationConfig<TDoc>,
) => {
  if (!config.httpHost) {
    throw new Error("httpHost is required for AppSync Events replication")
  }

  // Initialize AppSync Events adapter for real-time updates
  const channel = buildChannelPath(config.appSyncChannel, config.recipientId)
  // Type assertion needed because AppSyncEventsAdapter expects
  // RxDbDocument with 'deleted' field, but our document types don't
  // include 'deleted' as it's handled internally by RxDB
  const eventsAdapter = new AppSyncEventsAdapter<
    TDoc & { deleted: boolean },
    PullCheckpoint
  >({
    channel,
    httpHost: config.httpHost,
    isCurrent: config.isCurrent,
    expiresAt: config.accessTokenExpiresAt,
  })

  // Connect to AppSync Events WebSocket (async, but doesn't block initialization)
  eventsAdapter.connect().catch((error) => {
    console.error("Failed to connect to AppSync Events:", error)
  })

  const pullHandler = async (
    checkpoint: PullCheckpoint | undefined,
    batchSize: number,
  ) => {
    if (!config.isCurrent()) throw new Error("Replication authority changed")
    const { query, variables } = config.pullQueryBuilder(checkpoint, batchSize)

    const response = await fetch(config.graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    })

    const result = await response.json()
    if (!config.isCurrent()) throw new Error("Replication authority changed")
    return result.data[config.pullResultKey]
  }

  const baseConfig: ReplicationOptions<TDoc, PullCheckpoint> = {
    collection: config.collection,
    replicationIdentifier: config.replicationIdentifier,
    deletedField: config.deletedField,
    pull: {
      handler: pullHandler,
      batchSize: 50,
      stream$: eventsAdapter.getStream(),
    },
    live: true,
    retryTime: 10000,
    // See GraphQL replication above: each active tab must subscribe with its
    // own current auth context instead of relying on an origin-wide leader.
    waitForLeadership: false,
    autoStart: true,
  }

  const replicationState = (() => {
    if (!config.pushQueryBuilder || !config.pushResultKey) {
      return replicateRxCollection<TDoc, PullCheckpoint>(baseConfig)
    }

    const pushResultKey = config.pushResultKey
    const pushQueryBuilder = config.pushQueryBuilder
    return replicateRxCollection<TDoc, PullCheckpoint>({
      ...baseConfig,
      push: {
        handler: async (rows: unknown[]) => {
          if (!config.isCurrent())
            throw new Error("Replication authority changed")
          const { query, variables } = pushQueryBuilder(rows)

          const response = await fetch(config.graphqlEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({ query, variables }),
          })

          const result = await response.json()
          if (!config.isCurrent())
            throw new Error("Replication authority changed")
          return result.data[pushResultKey]
        },
        batchSize: 5,
      },
    })
  })()

  const cancelReplication = replicationState.cancel.bind(replicationState)
  replicationState.cancel = () => {
    eventsAdapter.disconnect()
    return cancelReplication()
  }

  return replicationState
}

/**
 * Auto-detects replication mode based on environment variables.
 *
 * - If httpHost is provided → AppSync Events mode
 * - Otherwise → GraphQL WebSocket subscriptions mode
 */
export const createReplication = <TDoc extends RxDbDocumentBase>(
  config: ReplicationConfig<TDoc>,
) => {
  if (
    !config.recipientId ||
    !config.isCurrent() ||
    !Number.isSafeInteger(config.accessTokenExpiresAt) ||
    config.accessTokenExpiresAt <= Date.now() / 1000
  ) {
    throw new Error("Realtime authority is unavailable or changed")
  }
  const useAppSyncEvents = config.httpHost && config.httpHost.length > 0
  const accessToken = useAppSyncEvents ? getCookie("access_token") : undefined
  if (
    useAppSyncEvents &&
    !matchesRealtimeSessionToken(
      accessToken,
      config.session,
      config.accessTokenExpiresAt,
    )
  ) {
    throw new Error("Realtime credentials do not match the current session")
  }
  const isCurrent = config.isCurrent
  // Local graphql-ws validates expiry on the server and renews streams in place.
  // Only AWS transports are replaced for every token deadline.
  config = {
    ...config,
    isCurrent: () =>
      isCurrent() &&
      (!useAppSyncEvents ||
        (!!accessToken &&
          getCookie("access_token") === accessToken &&
          Date.now() < config.accessTokenExpiresAt * 1000)),
  }

  if (useAppSyncEvents) {
    console.log(
      `Using AppSync Events replication mode for ${config.replicationIdentifier}`,
    )
    return createAppSyncEventsReplication(config)
  } else {
    console.log(
      `Using GraphQL WebSocket subscriptions replication mode for ${config.replicationIdentifier}`,
    )
    return createGraphQLReplication(config)
  }
}
