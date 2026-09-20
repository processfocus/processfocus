/**
 * Global registry for AppSync Events adapters.
 * Allows stopping all adapters before re-entering the authentication boundary.
 */

import type { AppSyncEventsAdapter } from "./adapter"

// biome-ignore lint/suspicious/noExplicitAny: Generic adapter type
type AnyAdapter = AppSyncEventsAdapter<any, any>

/**
 * Set of all registered adapters
 */
const adapters = new Set<AnyAdapter>()

/**
 * Register an adapter for session teardown.
 * Should be called when creating an AppSync Events replication.
 */
export function registerAdapter(adapter: AnyAdapter): void {
  adapters.add(adapter)
}

/**
 * Unregister an adapter.
 * Should be called when cleaning up an AppSync Events replication.
 */
export function unregisterAdapter(adapter: AnyAdapter): void {
  adapters.delete(adapter)
}

export function disconnectAllAdapters(): void {
  for (const adapter of adapters) adapter.disconnect()
}
