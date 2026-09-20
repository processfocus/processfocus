/**
 * Todo notification observer - watches for new todos and dispatches desktop notifications.
 *
 * This module encapsulates new-todo detection and notification dispatch behind a small,
 * testable interface so browser APIs and live collection updates remain easy to reason about.
 *
 * User stories addressed:
 * - User story 8: Desktop notifications as additional channel
 * - User story 9: Popup only for newly arrived to-dos
 * - User story 10: Initial sync baseline without firing notifications
 * - User story 11: Minimal notification content
 * - User story 12: Click to open todo form
 * - User story 13: Focus app on click
 * - User story 15: Keep working while app is open
 * - User story 16: No notification when app is closed
 * - User story 18: Avoid notifying for routine edits
 * - User story 24: Encapsulated detection behind testable interface
 */

/**
 * Minimal todo data needed for notification dispatch.
 * This is a subset of TodoDocType to allow flexibility in what data sources we accept.
 */
interface TodoNotificationItem {
  id: string
  stepName: string
  stepPath: string
}

/**
 * Configuration for the todo notification observer
 */
interface TodoNotificationObserverConfig {
  /** Callback to get current notification preference state */
  isEnabled: () => boolean
  /** Callback to focus the app window and navigate to a todo */
  onNotificationClick: (todoId: string, stepPath: string) => void
  /** Optional callback when a notification is dispatched (for testing/metrics) */
  onNotificationDispatched?: (todoId: string) => void
}

/**
 * Notification observer state
 */
interface ObserverState {
  /** Set of todo IDs that have been seen (baseline established) */
  seenTodoIds: Set<string>
  /** Whether the initial baseline has been established */
  baselineEstablished: boolean
}

/**
 * Result of processing a todo list update
 */
interface ProcessUpdateResult {
  /** Whether the baseline was just established by this update */
  baselineEstablished: boolean
  /** Number of new todo notifications dispatched */
  notificationsDispatched: number
  /** IDs of todos that triggered notifications */
  notifiedTodoIds: string[]
}

/**
 * Create a new todo notification observer.
 *
 * The observer maintains a baseline of seen todo IDs and dispatches notifications
 * only when brand-new todo IDs appear after the baseline is established.
 *
 * @example
 * ```typescript
 * const observer = createTodoNotificationObserver({
 *   isEnabled: () => preferenceState.isEnabled,
 *   onNotificationClick: (todoId, stepPath) => {
 *     window.focus()
 *     router.push(`/to-dos/complete/${stepPath}?todoId=${todoId}`)
 *   }
 * })
 *
 * // Process initial load (establishes baseline, no notifications)
 * observer.processUpdate(todos)
 *
 * // Process live update (dispatches notifications for new todos)
 * observer.processUpdate(updatedTodos)
 * ```
 */
export function createTodoNotificationObserver(
  config: TodoNotificationObserverConfig,
) {
  const state: ObserverState = {
    seenTodoIds: new Set(),
    baselineEstablished: false,
  }

  /**
   * Dispatch a desktop notification for a new todo.
   * Returns true if a notification was actually dispatched.
   */
  const dispatchNotification = (todo: TodoNotificationItem): boolean => {
    if (!config.isEnabled()) {
      return false
    }

    // Minimal notification content - no sensitive workflow details
    const title = "New to-do arrived"
    const body = todo.stepName || "A new task requires your attention"

    try {
      const notification = new Notification(title, {
        body,
        tag: `todo-${todo.id}`, // Prevents duplicate notifications for same todo
        requireInteraction: false, // Auto-dismiss after typical notification duration
      })

      // Handle click: focus app and open todo form
      notification.onclick = () => {
        notification.close()
        if (todo.stepPath) {
          config.onNotificationClick(todo.id, todo.stepPath)
        }
      }

      config.onNotificationDispatched?.(todo.id)
      return true
    } catch {
      // Notification constructor can throw in some contexts - fail silently
      return false
    }
  }

  /**
   * Process a list of todos and dispatch notifications for new ones.
   *
   * First call establishes the baseline without notifying.
   * Subsequent calls notify only for previously unseen todo IDs.
   *
   * @param todos - Current list of todos from the collection
   * @returns Result describing what happened during processing
   */
  const processUpdate = (
    todos: TodoNotificationItem[],
  ): ProcessUpdateResult => {
    const result: ProcessUpdateResult = {
      baselineEstablished: false,
      notificationsDispatched: 0,
      notifiedTodoIds: [],
    }

    // First update: establish baseline
    if (!state.baselineEstablished) {
      // Mark all current todos as seen - this is the baseline
      for (const todo of todos) {
        state.seenTodoIds.add(todo.id)
      }
      state.baselineEstablished = true
      result.baselineEstablished = true
      return result
    }

    // Subsequent updates: detect new todos
    for (const todo of todos) {
      if (!state.seenTodoIds.has(todo.id)) {
        // This is a brand-new todo - dispatch notification
        const dispatched = dispatchNotification(todo)
        state.seenTodoIds.add(todo.id)
        if (dispatched) {
          result.notificationsDispatched++
          result.notifiedTodoIds.push(todo.id)
        }
      }
    }

    return result
  }
  return {
    processUpdate,
  }
}
