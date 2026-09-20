import { cleanupAllPlugins } from "@pf/form-client-representation/plugin-registry"
import { cleanupDraftProcessCollection } from "@/lib/collections/draft-process-execution-collection-provider"
import { cleanupExecutionCollection } from "@/lib/collections/execution-collection-provider"
import { cleanupProcessCollection } from "@/lib/collections/process-collection-provider"
import { cleanupRxDb } from "@/lib/collections/rxdb-provider"
import { cleanupTodoCollection } from "@/lib/collections/todo-collection-provider"
import { resetFrontendClientPluginIdentity } from "@/lib/frontend-client-plugin-registry"

/**
 * Performs client-side logout by cleaning up all local state before
 * contacting the server. This ensures replications are cancelled and
 * RxDB is cleaned up before the session is invalidated.
 */
export async function performClientLogout(): Promise<void> {
  resetFrontendClientPluginIdentity()

  // Cleanup all collections first (cancels replications), then cleanup RxDB.
  // Errors are caught to ensure logout completes even if cleanup fails.
  try {
    await Promise.all([
      cleanupDraftProcessCollection(),
      cleanupExecutionCollection(),
      cleanupProcessCollection(),
      cleanupTodoCollection(),
    ])
    await cleanupRxDb()
    cleanupAllPlugins()
  } catch (error) {
    console.error("Failed to cleanup during logout:", error)
  }
  await fetch("/api/auth/logout", { method: "POST" })
  // Use full page navigation to trigger server-side layout re-render
  // This ensures the session check in root layout runs fresh
  window.location.href = "/login"
}
