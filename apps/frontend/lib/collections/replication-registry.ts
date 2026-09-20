/**
 * Registry for collection replication recreation.
 *
 * Collection providers auto-register when they initialize and unregister on cleanup.
 * This allows recreateAllReplications to be called from anywhere (e.g., Header on role switch)
 * without needing hooks or provider nesting - only active replications are affected.
 */

import type { ReplicationRuntimeConfig } from "./collection-provider-factory"
import { reconnectGraphQLStreams } from "./graphql-stream"

type RecreateReplicationFn = (
  runtimeConfig: ReplicationRuntimeConfig,
) => Promise<void>

// Module-level registry of active collection replication recreators
const replicationRegistry = new Map<
  string,
  {
    recreateFn: RecreateReplicationFn
    refreshCredentials: (expiresAt: number, cacheScope: string) => Promise<void>
  }
>()

type CredentialState =
  | {
      status: "pending"
      cacheScope: string
      promise: Promise<number>
      resolve: (expiresAt: number) => void
      reject: (error: Error) => void
    }
  | { status: "committed"; cacheScope: string; expiresAt: number }
  | { status: "failed"; cacheScope: string }
let credentials: CredentialState | undefined

/** Called before refresh can replace cookies, not just before renewing transports. */
export function beginReplicationCredentialRefresh(
  cacheScope: string,
): () => void {
  if (
    credentials?.status !== "pending" ||
    credentials.cacheScope !== cacheScope
  ) {
    if (credentials?.status === "pending")
      credentials.reject(new Error("Session changed during refresh"))
    let resolve: (expiresAt: number) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<number>((res, rej) => {
      resolve = res
      reject = rej
    })
    void promise.catch(() => {})
    credentials = { status: "pending", cacheScope, promise, resolve, reject }
  }
  const pending = credentials
  // Cleanup from an old attempt must not invalidate a newer same-scope refresh.
  return () => {
    if (credentials === pending) invalidateReplicationCredentials(cacheScope)
  }
}

export function invalidateReplicationCredentials(cacheScope: string): void {
  if (credentials?.cacheScope !== cacheScope) return
  if (credentials.status === "pending")
    credentials.reject(new Error("Session refresh failed"))
  credentials = { status: "failed", cacheScope }
}

/** A late collection must use committed credentials even before React has rerendered. */
export function getReplicationExpiry(
  cacheScope: string,
  fallback: number,
): number | Promise<number> {
  if (!credentials || credentials.cacheScope !== cacheScope) return fallback
  switch (credentials.status) {
    case "pending":
      return credentials.promise
    case "committed":
      return credentials.expiresAt
    case "failed":
      throw new Error("Session refresh failed")
  }
}

/**
 * Register a collection's recreateReplication function.
 * Called automatically by collection providers when they initialize.
 */
export function registerReplication(
  name: string,
  recreateFn: RecreateReplicationFn,
  refreshCredentials: (expiresAt: number, cacheScope: string) => Promise<void>,
): void {
  replicationRegistry.set(name, { recreateFn, refreshCredentials })
}

/**
 * Unregister a collection's recreateReplication function.
 * Called automatically by collection providers on cleanup.
 */
export function unregisterReplication(name: string): void {
  replicationRegistry.delete(name)
}

/**
 * Clear every registered recreation callback.
 *
 * RxDB removal closes all collections for the database. Some collection
 * providers may be unmounted when that happens, so they cannot observe the new
 * collection object and unregister themselves. Clearing the registry prevents a
 * later role switch from calling stale recreators bound to closed collections.
 */
export function clearReplicationRegistry(): void {
  replicationRegistry.clear()
  if (credentials?.status === "pending")
    credentials.reject(new Error("Session closed during refresh"))
  credentials = undefined
}

/** Replace token-bound transports without clearing collections or checkpoints. */
export async function refreshReplicationCredentials(
  expiresAt: number,
  cacheScope: string,
): Promise<void> {
  const previous = credentials
  // Commit before taking the snapshot: new registrations initialize with this
  // expiry and do not depend on being included in the renewal snapshot.
  const committed: CredentialState = {
    status: "committed",
    cacheScope,
    expiresAt,
  }
  credentials = committed
  if (previous?.status === "pending") {
    if (previous.cacheScope === cacheScope) previous.resolve(expiresAt)
    else previous.reject(new Error("Session changed during refresh"))
  }
  try {
    await Promise.all(
      [...replicationRegistry.values()].map(({ refreshCredentials }) =>
        refreshCredentials(expiresAt, cacheScope),
      ),
    )
    if (credentials !== committed)
      throw new Error("Session changed during credential refresh")
    reconnectGraphQLStreams(cacheScope)
  } catch (error) {
    if (credentials === committed)
      credentials = { status: "failed", cacheScope }
    throw error
  }
}

/**
 * Recreate all registered replications.
 * Used when auth context changes (e.g., role switch).
 *
 * @returns Object with success status and any errors
 */
export async function recreateAllReplications(
  runtimeConfig: ReplicationRuntimeConfig,
): Promise<{
  success: boolean
  errors: Array<{ name: string; error: unknown }>
}> {
  const errors: Array<{ name: string; error: unknown }> = []
  const count = replicationRegistry.size

  if (count === 0) {
    console.log("No active replications to recreate")
    return { success: true, errors: [] }
  }

  console.log(`Recreating ${count} active replication(s)...`)

  // Run all recreations sequentially to avoid concurrent request bursts
  for (const [name, { recreateFn }] of replicationRegistry.entries()) {
    try {
      await recreateFn(runtimeConfig)
    } catch (error) {
      console.error(`Failed to recreate ${name} replication:`, error)
      errors.push({ name, error })
    }
  }

  const successCount = count - errors.length
  console.log(
    `Replication recreation complete: ${successCount}/${count} succeeded`,
  )

  return {
    success: errors.length === 0,
    errors,
  }
}
