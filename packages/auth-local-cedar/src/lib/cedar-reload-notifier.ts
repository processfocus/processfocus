import { Context } from "effect"

/**
 * Service that notifies when Cedar policies are successfully reloaded.
 * This is used to invalidate frontend caches when hot-reload happens.
 */
export interface CedarReloadNotifier {
  /**
   * Called immediately after a successful Cedar policy hot-swap.
   * Implementations should handle their own error handling and logging.
   * Failures should be non-fatal - they should not crash the runtime.
   */
  readonly onCedarReloaded: () => void
}

export class CedarReloadNotifierService extends Context.Tag(
  "@pf/auth-local-cedar/CedarReloadNotifierService",
)<CedarReloadNotifierService, CedarReloadNotifier>() {}
