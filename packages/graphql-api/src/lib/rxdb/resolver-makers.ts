import { SqlClient } from "@effect/sql"
// biome-ignore lint/suspicious/noShadowRestrictedNames: Effect Array module
import { Array, type Context, Effect, Either } from "effect"
import type { GraphQLSchema } from "graphql"
import {
  CurrentPrincipal,
  type DelegationPrincipal,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
} from "@pf/auth-policy"
import { UserDetails } from "@pf/graphql-db-operations"
import type { InputMaybe, RxDbDocument } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { RealtimeEvent } from "../delegated-realtime"
import type { UserContext } from "../types"
import type {
  PushResult,
  RxDbCollectionOps,
  RxDbPushRowInput,
} from "./collection-ops"

/**
 * Pull bulk event structure for RxDB replication.
 */
interface RxDbPullBulkEvent<GraphQL extends RxDbDocument> {
  documents: GraphQL[]
  checkpoint?: { id: string; updatedAt: number } | null
}

export const rxDbMasterStatesMatch = (
  current: RxDbDocument,
  assumed: RxDbDocument,
): boolean =>
  current.id === assumed.id &&
  current.updatedAt === assumed.updatedAt &&
  current.deleted === assumed.deleted

/**
 * Event service interface for RxDB collection subscriptions.
 * Each collection that supports subscriptions needs an event service.
 *
 * The event type is flexible to allow using existing GraphQL generated types
 * like DraftProcessExecutionPullBulk which are structurally compatible.
 */
interface RxDbEventService<
  GraphQL extends RxDbDocument,
  Event = RxDbPullBulkEvent<GraphQL>,
  SubscribeError = never,
  EmitError = never,
> {
  /**
   * Notify subscribers of a change.
   *
   * Implementations close over runtime dependencies when the service layer is
   * constructed, so emit has no remaining requirements.
   * @param event The change event containing documents and checkpoint
   * @param schema The GraphQL schema for serializing custom scalars
   */
  readonly emit: (
    event: Event,
    schema: GraphQLSchema,
  ) => Effect.Effect<void, EmitError, never>
  readonly subscribe: () => Effect.Effect<AsyncIterable<Event>, SubscribeError>
}

/**
 * Creates a push resolver for RxDB replication.
 *
 * The push resolver handles the RxDB replication write protocol:
 * 1. Processes each write row in a transaction
 * 2. Determines operation type (insert/update/delete) from row state
 * 3. Tracks conflicts and successful writes
 * 4. Optionally emits events for subscriptions
 * 5. Returns conflicts to client for resolution
 *
 * @param tag - Effect service tag for the collection operations
 * @param eventTag - Optional event service tag for subscription notifications
 * @returns Resolver function for the push mutation
 */
export const makePushResolver =
  <
    Id,
    Row,
    GraphQL extends RxDbDocument,
    InsertInput extends RxDbDocument,
    MapContext,
    EventId,
    // Event type defaults to RxDbPullBulkEvent<GraphQL> but can be overridden
    // to match GraphQL generated types like DraftProcessExecutionPullBulk
    Event extends {
      documents: GraphQL[]
      checkpoint?: { id: string; updatedAt: number } | null
    } = RxDbPullBulkEvent<GraphQL>,
  >(
    tag: Context.Tag<
      Id,
      RxDbCollectionOps<Row, GraphQL, InsertInput, MapContext>
    >,
    // biome-ignore lint/suspicious/noExplicitAny: makePushResolver only calls emit, doesn't use subscribe
    eventTag?: Context.Tag<EventId, RxDbEventService<GraphQL, Event, any>>,
  ) =>
  (
    writeRows:
      | InputMaybe<Array<RxDbPushRowInput<InsertInput & { id: string }>>>
      | undefined,
    schema?: GraphQLSchema,
  ): Effect.Effect<
    PushResult<GraphQL>,
    Error,
    Id | SqlClient.SqlClient | RequestTime | UserDetails | EventId | MapContext
  > =>
    Effect.gen(function* () {
      if (!writeRows) {
        return { conflicts: [], successful: [] }
      }

      const sql = yield* SqlClient.SqlClient
      const ops = yield* tag

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const conflicts: GraphQL[] = []
          const successfulIds: string[] = []

          for (const row of writeRows) {
            if (row.assumedMasterState) {
              const currentRows = yield* ops.getByIds([row.newDocumentState.id])
              const currentRow = currentRows[0]

              if (!currentRow) {
                yield* Effect.logWarning(
                  `RxDB collection conflict for missing document ${row.newDocumentState.id}`,
                )
                continue
              }

              const current = yield* ops.mapToGraphql(currentRow)
              if (!rxDbMasterStatesMatch(current, row.assumedMasterState)) {
                conflicts.push(current)
                continue
              }
            }

            const operation = !row.assumedMasterState
              ? ops.insert(row.newDocumentState.id, row.newDocumentState)
              : row.newDocumentState.deleted
                ? ops.delete(row.newDocumentState.id, row.assumedMasterState)
                : ops.update(
                    row.newDocumentState.id,
                    row.newDocumentState,
                    row.assumedMasterState,
                  )

            const result = yield* Effect.either(operation)

            if (Either.isRight(result)) {
              successfulIds.push(row.newDocumentState.id)
            } else {
              yield* Effect.logWarning(
                `RxDB collection conflict for document ${row.newDocumentState.id}`,
                result.left,
              )
              const currentRows = yield* ops.getByIds([row.newDocumentState.id])
              const currentRow = currentRows[0]
              if (currentRow) {
                conflicts.push(yield* ops.mapToGraphql(currentRow))
              }
            }
          }

          const successfulRows =
            successfulIds.length > 0 ? yield* ops.getByIds(successfulIds) : []
          const successful = yield* Effect.all(
            Array.map(successfulRows, ops.mapToGraphql),
            { concurrency: "unbounded" },
          )

          // Emit events for subscribers if event service provided and schema available
          if (eventTag && successful.length > 0 && schema) {
            const events = yield* eventTag

            // Calculate checkpoint from highest (updatedAt, id) document
            const sorted = [...successful].sort((a, b) => {
              if (a.updatedAt !== b.updatedAt) {
                return a.updatedAt - b.updatedAt
              }
              return a.id.localeCompare(b.id)
            })

            const lastDoc = sorted[sorted.length - 1]
            const checkpoint: { id: string; updatedAt: number } | null = lastDoc
              ? { id: lastDoc.id, updatedAt: lastDoc.updatedAt }
              : null

            yield* events.emit(
              { documents: successful, checkpoint } as Event,
              schema,
            )
          }

          return { conflicts, successful }
        }),
      )
    })

/**
 * Filter function signature for authorized stream subscriptions.
 * Takes documents and a principal, returns filtered documents.
 */
type AuthorizationFilterFn<
  GraphQL extends RxDbDocument,
  Principal,
  R = never,
> = (
  documents: readonly GraphQL[],
  principal: Principal,
) => Effect.Effect<GraphQL[], unknown, R>

/**
 * Creates an authorized subscription resolver for RxDB replication streaming.
 *
 * Per-subscriber authorization filtering:
 * 1. Subscribes to the event service
 * 2. For each event, filters documents by authorization using the provided filter function
 * 3. Only yields events with at least one authorized document
 *
 * This is used by the local runtime to filter events per subscriber.
 * AWS runtime uses a different approach (per-user channels with registry).
 *
 * `execute` must be closed over at the ManagedRuntime boundary (e.g.
 * `createResolverExecutor(runtime).runPromise`) — do not pass ManagedRuntime.
 *
 * @param eventTag - Event service tag for the collection
 * @param fieldName - GraphQL subscription field name (e.g., "streamTodo")
 * @param filterFn - Authorization filter function to apply to each event
 * @param buildPrincipalFn - Function to build principal from user context
 * @param execute - Promise runner closed over the process runtime
 * @returns Subscription resolver with subscribe function
 */
export const makeAuthorizedStreamSubscription = <
  EventId,
  Event extends {
    documents: GraphQL[]
    checkpoint?: { id: string; updatedAt: number } | null
  },
  SubscribeError,
  GraphQL extends RxDbDocument,
  PrincipalR,
  FilterR,
  Principal extends
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
  EmitError = never,
>(
  eventTag: Context.Tag<
    EventId,
    RxDbEventService<GraphQL, Event, SubscribeError, EmitError>
  >,
  fieldName: string,
  filterFn: AuthorizationFilterFn<GraphQL, Principal, FilterR>,
  buildPrincipalFn: (
    context: UserContext,
  ) => Effect.Effect<Principal, unknown, PrincipalR>,
  execute: <A>(
    effect: Effect.Effect<
      A,
      unknown,
      PrincipalR | FilterR | RequestTime | UserDetails | CurrentPrincipal
    >,
    options?: { readonly signal: AbortSignal },
  ) => Promise<A>,
) => ({
  subscribe: () =>
    Effect.gen(function* () {
      const events = yield* eventTag
      const eventStream = yield* events.subscribe()

      return {
        [Symbol.asyncIterator]() {
          const iterator = eventStream[Symbol.asyncIterator]()
          return {
            async next() {
              const result = await iterator.next()
              if (result.done) return result
              const event = result.value
              return {
                done: false as const,
                value: new RealtimeEvent(async (context) => {
                  const filtered = await execute(
                    Effect.gen(function* () {
                      const principal = yield* buildPrincipalFn(context)
                      const requestTime = yield* RequestTime
                      const userDetails = yield* UserDetails
                      const currentPrincipal = yield* CurrentPrincipal
                      return yield* filterFn(event.documents, principal).pipe(
                        Effect.locally(requestTime, context._requestTime),
                        Effect.locally(userDetails, context._userDetails),
                        Effect.locally(
                          currentPrincipal,
                          "orgUnit" in principal ? principal : null,
                        ),
                      )
                    }),
                    context._realtimeAbortSignal
                      ? { signal: context._realtimeAbortSignal }
                      : undefined,
                  )
                  if (filtered.length === 0) return null
                  return {
                    [fieldName]: {
                      documents: filtered,
                      checkpoint: event.checkpoint,
                    },
                  }
                }),
              }
            },
            return: () =>
              iterator.return
                ? iterator.return()
                : Promise.resolve({ done: true as const, value: undefined }),
          }
        },
      }
    }),
})
