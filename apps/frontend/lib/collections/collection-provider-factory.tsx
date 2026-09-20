"use client"

import type { Collection } from "@tanstack/db"
import { createCollection } from "@tanstack/react-db"
import { rxdbCollectionOptions } from "@tanstack/rxdb-db-collection"
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"
import type { RxCollection } from "rxdb/plugins/core"
import type { RxReplicationState } from "rxdb/plugins/replication"
import type { RxGraphQLReplicationState } from "rxdb/plugins/replication-graphql"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import type { PullCheckpoint } from "../generated/gql/graphql"
import {
  canInitializeCollectionForScope,
  shouldResetCollectionBinding,
} from "./collection-provider-scope"
import { DatabaseErrorUI } from "./database-error-ui"
import {
  type PullQueryBuilder,
  type PushQueryBuilder,
  type ReplicationConfig,
  type StreamQueryBuilder,
  createReplication,
} from "./replication-factory"
import {
  getReplicationExpiry,
  registerReplication,
  unregisterReplication,
} from "./replication-registry"
import {
  type ProcessFocusDatabase,
  cleanupRxDb,
  useRxDb,
} from "./rxdb-provider"
import { useAuth } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"

/**
 * Configuration for creating a collection provider
 */
/**
 * Base type for all RxDB documents - must have id and updatedAt
 */
interface RxDbDocumentBase {
  id: string
  updatedAt: number
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const subscribeToHydration = () => () => {}
const getHydratedSnapshot = () => true
const getServerSnapshot = () => false

interface CollectionProviderConfig<TDoc extends RxDbDocumentBase> {
  /**
   * Name of the collection (used for error messages and identifiers)
   */
  name: string

  /**
   * Pull query builder for fetching data from server
   */
  pullQueryBuilder: PullQueryBuilder

  /**
   * Stream query builder for real-time subscriptions (optional - if not provided, uses polling only)
   */
  pullStreamQueryBuilder?: StreamQueryBuilder

  /**
   * Push query builder for sending data to server (optional for read-only collections)
   */
  pushQueryBuilder?: PushQueryBuilder

  /**
   * Field name for soft deletes
   */
  deletedField: string

  /**
   * AppSync Events channel path (e.g., "/rxdb/collection/process")
   */
  appSyncChannel: string

  /**
   * Key to extract pull result from GraphQL response (e.g., "pullProcess")
   */
  pullResultKey: string

  /**
   * Key to extract push result from GraphQL response (e.g., "pushProcess")
   */
  pushResultKey?: string

  /**
   * Function to get the RxDB collection from the database
   */
  getRxCollection: (db: ProcessFocusDatabase) => RxCollection<TDoc>

  /**
   * Optional hook to create TanStack DB indexes before queries subscribe.
   */
  createIndexes?: (collection: Collection<TDoc, string>) => void

  /**
   * One-time local reset key for server-derived fields that old checkpoints
   * cannot refresh unless local docs and replication metadata are cleared.
   */
  resetReplicationOnReadyKey?: string
}

type CollectionState<TDoc extends RxDbDocumentBase> =
  | {
      status: "waiting-for-rxdb" | "initializing"
      promise: Promise<Collection<TDoc, string>>
      resolve: (collection: Collection<TDoc, string>) => void
      reject: (error: Error) => void
    }
  | {
      status: "ready"
      collection: Collection<TDoc, string>
      replicationState:
        | RxReplicationState<TDoc, PullCheckpoint>
        | RxGraphQLReplicationState<TDoc, PullCheckpoint>
      promise: Promise<Collection<TDoc, string>>
    }
  | {
      status: "error"
      error: Error
      promise: Promise<Collection<TDoc, string>>
    }

type PendingCollectionState<TDoc extends RxDbDocumentBase> = Extract<
  CollectionState<TDoc>,
  { status: "waiting-for-rxdb" | "initializing" }
>

function isPendingCollectionState<TDoc extends RxDbDocumentBase>(
  state: CollectionState<TDoc>,
): state is PendingCollectionState<TDoc> {
  return state.status === "waiting-for-rxdb" || state.status === "initializing"
}

export type CollectionStateStatus = CollectionState<RxDbDocumentBase>["status"]

/**
 * Runtime configuration needed for replication
 */
export interface ReplicationRuntimeConfig {
  appSyncEventsHttpEndpoint: string
  graphqlEndpoint: string
  wsEndpoint: string
  /** Effective owner for recreation checks, never the realtime address. */
  userId: string
}

export interface CollectionContextValue<TDoc extends RxDbDocumentBase> {
  db: ProcessFocusDatabase | null
  rxCollection: RxCollection<TDoc> | null
  state: CollectionState<TDoc>
  /** Promise that resolves when the collection is ready - use with React's use() hook */
  collectionPromise: Promise<Collection<TDoc, string>>
  /**
   * Recreate replication from scratch - cancels old replication and creates fresh one.
   * Keeps the RxDB collection and TanStack collection intact.
   * Useful when authentication/authorization context changes (e.g., role switch).
   */
  recreateReplication: (
    runtimeConfig: ReplicationRuntimeConfig,
  ) => Promise<void>
}

const isRxDbAlreadyRemovedError = (error: unknown): boolean => {
  // RxDB replication metaInstance.remove() throws a plain Error("removed")
  // after the replication database is already gone. Collection operations use
  // COL21 for the same closed/removed lifecycle state.
  if (error instanceof Error && error.message === "removed") {
    return true
  }

  if (typeof error !== "object" || error === null) {
    return false
  }

  return (error as Record<string, unknown>)["code"] === "COL21"
}

/**
 * Creates a collection provider with all the necessary state management, replication,
 * and Suspense support.
 *
 * @returns An object with Provider component, useCollection hook, and cleanup function
 */
export function createCollectionProvider<TDoc extends RxDbDocumentBase>(
  config: CollectionProviderConfig<TDoc>,
) {
  function createPendingState(
    status: "waiting-for-rxdb" | "initializing",
  ): CollectionState<TDoc> {
    let resolve: (collection: Collection<TDoc, string>) => void = () => {}
    let reject: (error: Error) => void = () => {}

    const promise = new Promise<Collection<TDoc, string>>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Session teardown can reject before a Suspense consumer has subscribed.
    void promise.catch(() => {})

    return {
      status,
      promise,
      resolve,
      reject,
    }
  }

  // ==========================================================================
  // Module-level state
  // ==========================================================================
  // These variables live at module scope (not component state) for two reasons:
  // 1. React 18 Strict Mode double-mounts components—module state persists across
  //    unmount/remount so we don't re-initialize or lose WebSocket connections.
  // 2. Replication should stay alive across page navigation within the SPA.
  //
  // This state is reset in three ways:
  // - **Retry (error recovery)**: reloads the page, which reloads the module.
  // - **Logout**: calls cleanup() which manually resets these variables.
  // - **Org switch**: resets the singleton so the next scope gets a fresh collection.
  // - **RxDB remount**: resets when the same org gets a fresh RxDB collection.
  // ==========================================================================

  // Singleton state - survives component unmount/remount
  let persistentState: CollectionState<TDoc> =
    createPendingState("waiting-for-rxdb")

  // Prevents duplicate initialization starts (needed for React 18 Strict Mode double-mount)
  let initializationInProgress = false

  // Generation counter - incremented on cleanup() to invalidate in-progress initializations.
  // Any async init that started before cleanup() will detect the mismatch and abort.
  let cleanupGeneration = 0

  // Prevents a one-time reset from starting multiple concurrent recreations.
  let resetReplicationInProgress = false

  // Avoids repeating a completed reset when localStorage markers cannot be
  // written, for example in private browsing or storage-quota failures.
  const completedReplicationResetKeys = new Set<string>()

  // Module-level reference to rxCollection for use by registered recreate function
  let moduleRxCollection: RxCollection<TDoc> | null = null
  let replicationAuthority: ReturnType<typeof useAuth> | null = null
  let activeReplicationConfig: ReplicationConfig<TDoc> | null = null

  // Tracks which org scope the singleton state belongs to.
  let activeScopeKey: string | null = null
  let sessionCacheScope = ""

  // Callbacks to trigger React re-renders when replication is recreated
  const forceUpdateCallbacks = new Set<() => void>()

  function triggerAllUpdates(): void {
    for (const callback of forceUpdateCallbacks) {
      callback()
    }
  }

  /**
   * Module-level recreate function registered with the replication registry.
   * Called when role switches - recreates replication for this collection if active.
   */
  async function registeredRecreateReplication(
    runtimeConfig: ReplicationRuntimeConfig,
  ): Promise<void> {
    if (persistentState.status !== "ready" || !moduleRxCollection) {
      console.log(
        `${config.name} not ready for replication recreation, skipping`,
      )
      return
    }

    await recreateReplication(
      runtimeConfig,
      moduleRxCollection,
      triggerAllUpdates,
    )
  }

  const Context = createContext<CollectionContextValue<TDoc> | null>(null)

  /** Check if cleanup() was called since initialization started */
  function isStaleInitialization(startGeneration: number): boolean {
    return startGeneration !== cleanupGeneration
  }

  /**
   * Get or create a promise that resolves when the collection is ready.
   * This promise can be used with React's use() hook for Suspense integration.
   */
  function getCollectionPromise(): Promise<Collection<TDoc, string>> {
    return persistentState.promise
  }

  /**
   * Cleanup function for logout - cancels replication and resets singleton state
   */
  async function cleanup(): Promise<void> {
    cleanupGeneration++
    const previousState = persistentState
    // Unregister from the replication registry
    unregisterReplication(config.name)

    // Invalidate synchronously, before waiting for storage/socket teardown.
    initializationInProgress = false
    resetReplicationInProgress = false
    moduleRxCollection = null
    replicationAuthority = null
    activeReplicationConfig = null
    activeScopeKey = null
    forceUpdateCallbacks.clear()
    persistentState = createPendingState("waiting-for-rxdb")

    if (previousState.status === "ready") {
      try {
        await Promise.all([
          previousState.replicationState.cancel(),
          previousState.collection.cleanup(),
        ])
      } catch (error) {
        console.error(
          `Failed to cancel ${config.name} replication during cleanup:`,
          errorMessage(error),
        )
      }
    }
    // For pending states, don't reject - just abandon the promise. Components
    // using it unmount during logout, so the orphaned promise is GC'd.
  }

  function resetForScopeChange(
    nextScopeKey: string,
    nextRxCollection: RxCollection<TDoc> | null,
  ): Promise<void> | null {
    if (
      !shouldResetCollectionBinding({
        activeCollection: moduleRxCollection,
        activeScopeKey,
        nextCollection: nextRxCollection,
        nextScopeKey,
      })
    ) {
      return null
    }

    unregisterReplication(config.name)

    const previousState = persistentState

    initializationInProgress = false
    cleanupGeneration++
    moduleRxCollection = null
    replicationAuthority = null
    activeReplicationConfig = null
    activeScopeKey = null
    persistentState = createPendingState("waiting-for-rxdb")

    if (previousState.status === "ready") {
      return Promise.all([
        previousState.replicationState.cancel(),
        previousState.collection.cleanup(),
      ])
        .then(() => undefined)
        .catch((error: unknown) => {
          if (isRxDbAlreadyRemovedError(error)) {
            return
          }

          console.error(
            `Failed to cancel ${config.name} replication during collection reset:`,
            errorMessage(error),
          )
        })
    }

    return Promise.resolve()
  }

  /**
   * Recreate replication from scratch.
   * Clears local documents and replication checkpoint, then creates fresh replication.
   * Keeps the RxDB collection schema and TanStack collection intact.
   *
   * @param runtimeConfig - Runtime configuration with endpoints
   * @param rxCollection - The RxDB collection to replicate
   * @param forceUpdate - Optional callback to trigger React re-render
   */
  async function recreateReplication(
    runtimeConfig: ReplicationRuntimeConfig,
    rxCollection: RxCollection<TDoc>,
    forceUpdate?: () => void,
  ): Promise<void> {
    if (persistentState.status !== "ready") {
      console.error(
        `Cannot recreate ${config.name} replication - not in ready state (current: ${persistentState.status})`,
      )
      return
    }

    const { collection, replicationState: oldReplicationState } =
      persistentState
    const authority = replicationAuthority
    const startGeneration = cleanupGeneration
    if (
      !authority ||
      rxCollection !== moduleRxCollection ||
      runtimeConfig.userId !== authority.session.userId
    ) {
      throw new Error("Replication authority is unavailable or changed")
    }
    const isCurrent = () => !isStaleInitialization(startGeneration)

    console.log(`Recreating ${config.name} replication...`)

    try {
      const expiresAt = await getReplicationExpiry(
        getSessionCacheScope(authority.session),
        authority.expiresAt,
      )
      if (!isCurrent()) return
      // 1. Clear replication meta instance (checkpoint data) BEFORE cancelling
      // This removes the checkpoint so the next replication starts fresh
      if (oldReplicationState.metaInstance) {
        console.log(`Clearing ${config.name} replication checkpoint...`)
        try {
          await oldReplicationState.metaInstance.remove()
          console.log(`${config.name} replication checkpoint cleared`)
        } catch (error) {
          if (!isRxDbAlreadyRemovedError(error)) {
            throw error
          }
          console.log(
            `${config.name} replication checkpoint was already removed`,
          )
        }
      }

      // 2. Cancel old replication (after meta is cleared)
      console.log(`Cancelling old ${config.name} replication...`)
      try {
        await oldReplicationState.cancel()
      } catch (error) {
        if (!isRxDbAlreadyRemovedError(error)) {
          throw error
        }
        console.log(`${config.name} replication was already removed`)
      }

      // 3. Remove all local documents from the collection
      if (!isCurrent()) return
      // This ensures we don't show stale data from the old role
      console.log(`Removing local ${config.name} documents...`)
      const allDocs = await rxCollection.find().exec()
      if (!isCurrent()) return
      if (allDocs.length > 0) {
        const docIds = allDocs.map((doc) => doc.primary)
        await rxCollection.bulkRemove(docIds)
        console.log(`Removed ${docIds.length} local ${config.name} documents`)
      } else {
        console.log(`No local ${config.name} documents to remove`)
      }

      // 4. Build replication config
      const recipientId = await getRealtimeRecipientId(
        authority.session,
        expiresAt,
      )
      if (!isCurrent()) return
      const baseConfig = {
        cacheScope: sessionCacheScope,
        collection: rxCollection,
        pullQueryBuilder: config.pullQueryBuilder,
        deletedField: config.deletedField,
        replicationIdentifier: config.name,
        pullResultKey: config.pullResultKey,
        appSyncChannel: config.appSyncChannel,
        graphqlEndpoint: runtimeConfig.graphqlEndpoint,
        wsEndpoint: runtimeConfig.wsEndpoint,
        httpHost: runtimeConfig.appSyncEventsHttpEndpoint,
        recipientId,
        session: authority.session,
        accessTokenExpiresAt: expiresAt,
        isCurrent,
      }

      const replicationConfig: ReplicationConfig<TDoc> = {
        ...baseConfig,
        ...(config.pullStreamQueryBuilder
          ? { pullStreamQueryBuilder: config.pullStreamQueryBuilder }
          : {}),
        ...(config.pushQueryBuilder && config.pushResultKey
          ? {
              pushQueryBuilder: config.pushQueryBuilder,
              pushResultKey: config.pushResultKey,
            }
          : { pushQueryBuilder: undefined, pushResultKey: undefined }),
      }

      // 5. Create new replication
      console.log(`Creating new ${config.name} replication...`)
      const newReplicationState = await createReplication(replicationConfig)
      if (!isCurrent()) {
        await newReplicationState.cancel()
        return
      }
      activeReplicationConfig = replicationConfig
      replicationAuthority = { session: authority.session, expiresAt }

      // 6. Update persistent state (keep same collection and promise)
      persistentState = {
        status: "ready",
        collection,
        replicationState: newReplicationState,
        promise: persistentState.promise,
      }

      console.log(`${config.name} replication recreated successfully`)

      // 7. Trigger re-render if callback provided
      if (forceUpdate) {
        forceUpdate()
      }
    } catch (error) {
      console.error(`Failed to recreate ${config.name} replication:`, error)
      // Surface recreation failures to the role-switch coordinator. Keeping
      // the old state after a partial reset can leave stale role-scoped rows
      // visible, so callers need to fall back to a full local DB reset.
      throw error
    }
  }

  async function refreshCredentials(
    expiresAt: number,
    cacheScope: string,
  ): Promise<void> {
    if (isPendingCollectionState(persistentState)) await persistentState.promise
    if (
      persistentState.status !== "ready" ||
      !activeReplicationConfig ||
      !replicationAuthority
    ) {
      throw new Error("Replication is not ready for credential refresh")
    }
    const previousState = persistentState
    const previousConfig = activeReplicationConfig
    const session = replicationAuthority.session
    if (getSessionCacheScope(session) !== cacheScope)
      throw new Error("Replication authority changed")
    if (!previousConfig.httpHost) {
      // Local streams renew together after the barrier, retaining RxDB state.
      replicationAuthority = { session, expiresAt }
      return
    }
    const generation = ++cleanupGeneration
    const isCurrent = () => !isStaleInitialization(generation)
    // Invalidate old requests before waiting for socket/storage cancellation.
    await previousState.replicationState.cancel()
    const recipientId = await getRealtimeRecipientId(session, expiresAt)
    if (!isCurrent()) throw new Error("Replication authority changed")
    const nextConfig: ReplicationConfig<TDoc> = {
      ...previousConfig,
      recipientId,
      accessTokenExpiresAt: expiresAt,
      isCurrent,
    }
    const replicationState = await createReplication(nextConfig)
    if (!isCurrent()) {
      await replicationState.cancel()
      throw new Error("Replication authority changed")
    }
    replicationAuthority = { session, expiresAt }
    activeReplicationConfig = nextConfig
    persistentState = { ...previousState, replicationState }
    triggerAllUpdates()
  }

  function Provider({ children }: { children: ReactNode }) {
    const { appSyncEventsHttpEndpoint, graphqlEndpoint, orgId, wsEndpoint } =
      useRuntimeConfig()
    const { state: rxDbState } = useRxDb()
    const { session, expiresAt } = useAuth()
    const cacheScope = getSessionCacheScope(session)
    const scopeKey = JSON.stringify([
      orgId,
      getSessionCacheScope(session),
      "clientId" in session || session.delegation ? session : null,
    ])

    const db = rxDbState.status === "ready" ? rxDbState.db : null
    const rxCollection = db ? config.getRxCollection(db) : null
    // Effective owner for recreation checks; addresses come from the session.
    const userId = session.userId
    const isHydrated = useSyncExternalStore(
      subscribeToHydration,
      getHydratedSnapshot,
      getServerSnapshot,
    )

    const clearAndRetry = async () => {
      try {
        await cleanupRxDb()
      } catch (error) {
        console.error("Failed to cleanup before retry:", error)
      }
      window.location.reload() // Never returns—page reloads
    }

    // Local state to trigger re-renders when singleton changes
    const [, forceUpdate] = useState({})

    // Register forceUpdate callback for registry-triggered recreation
    useEffect(() => {
      const callback = () => forceUpdate({})
      forceUpdateCallbacks.add(callback)
      return () => {
        forceUpdateCallbacks.delete(callback)
      }
    }, [])

    useEffect(() => {
      const cancelPreviousReplication = resetForScopeChange(
        scopeKey,
        rxCollection,
      )

      if (!cancelPreviousReplication) {
        return
      }

      // Flush the reset singleton state into context immediately so consumers stop
      // reading the previous org's ready collection while the new scope initializes.
      forceUpdate({})
    }, [scopeKey, rxCollection])

    useEffect(() => {
      let cancelled = false

      // Early return if RxDB not ready
      if (!db || !rxCollection) {
        return
      }

      // Atomic check-and-set to prevent race conditions where multiple components
      // could both see status as waiting before either sets initializing
      // Also check initializationInProgress to prevent React 18 Strict Mode double-init
      if (
        !canInitializeCollectionForScope({
          activeScopeKey,
          initializationInProgress,
          nextScopeKey: scopeKey,
          persistentStatus: persistentState.status,
        })
      ) {
        return
      }

      // Type guard: canInitializeCollectionForScope returning true guarantees
      // we're in "waiting-for-rxdb" state, but TypeScript can't infer this.
      if (persistentState.status !== "waiting-for-rxdb") {
        return
      }

      // Mark initialization as in progress BEFORE any async work
      initializationInProgress = true
      activeScopeKey = scopeKey
      sessionCacheScope = cacheScope
      replicationAuthority = { session, expiresAt }
      registerReplication(
        config.name,
        registeredRecreateReplication,
        refreshCredentials,
      )

      // Capture generation to detect if cleanup was called during initialization
      const startGeneration = cleanupGeneration

      // Preserve the existing promise/resolvers, just change status
      const previousState = persistentState

      // Mark as initializing immediately after the check to minimize race window
      persistentState = {
        ...previousState,
        status: "initializing",
      }

      const baseConfig = {
        collection: rxCollection,
        cacheScope: sessionCacheScope,
        pullQueryBuilder: config.pullQueryBuilder,
        deletedField: config.deletedField,
        replicationIdentifier: config.name,
        pullResultKey: config.pullResultKey,
        appSyncChannel: config.appSyncChannel,
        graphqlEndpoint,
        wsEndpoint,
        httpHost: appSyncEventsHttpEndpoint,
        accessTokenExpiresAt: expiresAt,
        session,
        isCurrent: () => !isStaleInitialization(startGeneration),
      }

      const replicationConfig = {
        ...baseConfig,
        ...(config.pullStreamQueryBuilder
          ? { pullStreamQueryBuilder: config.pullStreamQueryBuilder }
          : {}),
        ...(config.pushQueryBuilder && config.pushResultKey
          ? {
              pushQueryBuilder: config.pushQueryBuilder,
              pushResultKey: config.pushResultKey,
            }
          : { pushQueryBuilder: undefined, pushResultKey: undefined }),
      }

      const initializeReplication = async () => {
        try {
          const cacheScope = getSessionCacheScope(session)
          let effectiveExpiresAt: number
          let recipientId: string | undefined
          do {
            effectiveExpiresAt = await getReplicationExpiry(
              cacheScope,
              expiresAt,
            )
            recipientId = await getRealtimeRecipientId(
              session,
              effectiveExpiresAt,
            )
            if (isStaleInitialization(startGeneration)) return
          } while (
            getReplicationExpiry(cacheScope, expiresAt) !== effectiveExpiresAt
          )
          if (isStaleInitialization(startGeneration)) return
          replicationAuthority = { session, expiresAt: effectiveExpiresAt }
          const resolvedConfig: ReplicationConfig<TDoc> = {
            ...replicationConfig,
            recipientId,
            accessTokenExpiresAt: effectiveExpiresAt,
          }
          const replicationState = await createReplication(resolvedConfig)

          // NOTE: We intentionally do NOT cancel the replication even if the React effect
          // was cancelled (e.g., during React 18 Strict Mode double-mount).
          // Cancelling would close the WebSocket connection. Instead, we let the
          // replication stay alive and proceed to update module state to "ready".
          // The second mount will see status != "waiting-for-rxdb" and skip initialization.

          const collection: Collection<TDoc, string> = createCollection(
            rxdbCollectionOptions({
              rxCollection,
              startSync: true,
            }),
          )

          if (config.createIndexes) {
            config.createIndexes(collection)
          }

          // If cleanup/retry was called, cancel replication and bail out.
          // Note: initializationInProgress was already reset by cleanup/retry.
          if (isStaleInitialization(startGeneration)) {
            try {
              await replicationState.cancel()
              await collection.cleanup()
            } catch {
              // Ignore - replication may already be cancelled
            }
            return
          }

          // NOTE: We proceed even if the React effect's `cancelled` flag is set
          // (e.g., during React 18 Strict Mode double-mount). The replication is
          // already created and we want to keep it alive. The module state will be
          // updated to "ready" so the second mount will reuse it.
          // However, if cleanup() was called (checked above), we DO abort.

          // Resolve the promise for Suspense integration
          if (isPendingCollectionState(persistentState)) {
            persistentState.resolve(collection)
          } else {
            console.error("Unexpected state during initialization completion")
          }

          // Store in singleton
          persistentState = {
            status: "ready",
            collection,
            replicationState,
            // Keep the same promise instance that is now resolved
            promise: persistentState.promise,
          }

          // Store rxCollection at module level for registry access
          moduleRxCollection = rxCollection
          activeReplicationConfig = resolvedConfig

          // Clear the in-progress flag now that we're done
          initializationInProgress = false

          // Every mounted Provider shares this singleton state. Notify all of
          // them regardless of which instance started initialization.
          triggerAllUpdates()
        } catch (error) {
          // If cleanup/retry was called, bail out (flag already reset by them)
          if (isStaleInitialization(startGeneration)) {
            return
          }

          console.error(
            `Failed to initialize ${config.name} replication:`,
            error,
          )

          const errorObj = asError(error)

          // Reject the promise for Suspense integration
          if (isPendingCollectionState(persistentState)) {
            persistentState.reject(errorObj)
          } else {
            console.error("Unexpected state during initialization failure")
          }

          persistentState = {
            status: "error",
            error: errorObj,
            // Keep the same promise instance that is now rejected
            promise: persistentState.promise,
          }

          // Clear the in-progress flag on error
          initializationInProgress = false

          // Ensure the app-level recovery surface updates even when another
          // Provider instance won the initialization race.
          triggerAllUpdates()
        }
      }

      initializeReplication().catch((error) => {
        if (cancelled || isStaleInitialization(startGeneration)) {
          return
        }

        console.error(
          `Unhandled error in ${config.name} initialization:`,
          error,
        )
        // Fallback error handling in case the async function throws before try block
        const errorObj = asError(error)

        if (isPendingCollectionState(persistentState)) {
          persistentState.reject(errorObj)
        }

        persistentState = {
          status: "error",
          error: errorObj,
          promise: persistentState.promise,
        }

        // Clear the in-progress flag on error
        initializationInProgress = false

        triggerAllUpdates()
      })

      // Cleanup function - sets cancelled flag but does NOT cancel replication
      // The replication persists at module level across unmounts to keep WebSocket alive
      return () => {
        cancelled = true
        // We do NOT cancel the replication or reset state here.
        // The async initialization will complete and store the replication in module state.
        // This ensures WebSocket connections persist across React's double-mount (Strict Mode)
        // and across page navigation.
      }
    }, [
      appSyncEventsHttpEndpoint,
      cacheScope,
      db,
      rxCollection,
      graphqlEndpoint,
      scopeKey,
      wsEndpoint,
      session,
      expiresAt,
    ])

    useEffect(() => {
      if (!config.resetReplicationOnReadyKey || !rxCollection) {
        return
      }

      let cancelled = false

      const resetWhenReady = async () => {
        try {
          await getCollectionPromise()
        } catch (error) {
          console.error(
            `Failed to wait for ${config.name} before replication reset:`,
            error,
          )
          return
        }

        if (
          cancelled ||
          persistentState.status !== "ready" ||
          activeScopeKey !== scopeKey
        ) {
          return
        }

        const storageKey = [
          "pf",
          orgId,
          scopeKey,
          config.name,
          "replication-reset",
          config.resetReplicationOnReadyKey,
        ].join(":")

        if (completedReplicationResetKeys.has(storageKey)) {
          return
        }

        try {
          if (window.localStorage.getItem(storageKey) === "done") {
            completedReplicationResetKeys.add(storageKey)
            return
          }
        } catch (error) {
          console.warn(
            `Unable to read ${config.name} replication reset marker:`,
            errorMessage(error),
          )
        }

        if (resetReplicationInProgress) {
          return
        }

        resetReplicationInProgress = true
        recreateReplication(
          {
            appSyncEventsHttpEndpoint,
            graphqlEndpoint,
            userId,
            wsEndpoint,
          },
          rxCollection,
          triggerAllUpdates,
        )
          .then(() => {
            completedReplicationResetKeys.add(storageKey)
            try {
              window.localStorage.setItem(storageKey, "done")
            } catch (error) {
              console.warn(
                `Unable to write ${config.name} replication reset marker:`,
                errorMessage(error),
              )
            }
          })
          .catch((error) => {
            console.error(`Failed to reset ${config.name} replication:`, error)
          })
          .finally(() => {
            resetReplicationInProgress = false
          })
      }

      resetWhenReady()

      return () => {
        cancelled = true
      }
    }, [
      appSyncEventsHttpEndpoint,
      graphqlEndpoint,
      orgId,
      rxCollection,
      scopeKey,
      userId,
      wsEndpoint,
    ])

    // Memoize recreateReplication to avoid new function reference each render
    // Note: persistentState is module-level so we access it directly in the callback
    const recreateReplicationCallback = useCallback(
      async (runtimeConfig: ReplicationRuntimeConfig) => {
        if (activeScopeKey !== scopeKey) {
          throw new Error("Replication authority changed")
        }
        // Wait for collection to be ready if not yet
        if (persistentState.status !== "ready") {
          console.log(
            `${config.name} not ready (${persistentState.status}), waiting for collection...`,
          )
          try {
            await getCollectionPromise()
            console.log(`${config.name} collection is now ready`)
          } catch (error) {
            console.error(
              `Failed to wait for ${config.name} collection:`,
              error,
            )
            return
          }
        }

        // After awaiting, persistentState should be updated (it's module-level)
        if (persistentState.status !== "ready") {
          console.error(
            `${config.name} still not ready after awaiting - cannot recreate replication`,
          )
          return
        }

        if (!rxCollection) {
          console.error(
            `Cannot recreate ${config.name} replication - rxCollection not available`,
          )
          return
        }
        if (activeScopeKey !== scopeKey) {
          throw new Error("Replication authority changed")
        }
        await recreateReplication(
          runtimeConfig,
          rxCollection,
          triggerAllUpdates,
        )
      },
      [rxCollection, scopeKey],
    )

    // Scope resets replace the singleton; never retain its previous context value.
    const contextValue: CollectionContextValue<TDoc> = {
      db,
      rxCollection,
      state: persistentState,
      collectionPromise: getCollectionPromise(),
      recreateReplication: recreateReplicationCallback,
    }

    // Effects cancel old replication after render. Do not publish the previous
    // authority's already-ready singleton during that intervening render.
    if (
      activeScopeKey !== scopeKey ||
      (persistentState.status === "ready" &&
        moduleRxCollection !== rxCollection)
    )
      return null

    return (
      <Context.Provider value={contextValue}>
        {isHydrated ? (
          persistentState.status === "error" ? (
            <DatabaseErrorUI
              error={persistentState.error}
              onRetry={clearAndRetry}
            />
          ) : (
            children
          )
        ) : null}
      </Context.Provider>
    )
  }

  function useCollection() {
    const context = useContext(Context)
    if (!context) {
      throw new Error(
        `use${config.name}Collection must be used within ${config.name}CollectionProvider`,
      )
    }
    return context
  }

  /**
   * Optional variant that returns null if not within provider.
   * Useful for components that may render outside the provider context.
   */
  function useCollectionOptional(): CollectionContextValue<TDoc> | null {
    return useContext(Context)
  }

  return {
    Provider,
    useCollection,
    useCollectionOptional,
    cleanup,
  }
}
