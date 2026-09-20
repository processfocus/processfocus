/**
 * Queue name constants for job processing.
 * Centralized here to avoid circular dependencies between packages.
 */

/**
 * Queue name for flow execution jobs.
 * Used for counting pending jobs when checking process completion.
 */
export const FLOW_EXECUTION_QUEUE = "flow-execution"

/**
 * Queue name for todo-event jobs.
 * These jobs fetch todo data and publish events after todos are created.
 */
export const TODO_EVENT_QUEUE = "todo-event"

/**
 * Queue name for process-event jobs.
 * These jobs fetch process data and publish events after process changes.
 */
export const PROCESS_EVENT_QUEUE = "process-event"

/**
 * Queue name for execution-event jobs.
 * These jobs fetch execution data and publish events after execution changes.
 */
export const EXECUTION_EVENT_QUEUE = "execution-event"

/**
 * Queue name for system-step-execution jobs.
 * These jobs execute SystemSteps (steps with no role) automatically
 * when the flow reaches them.
 */
export const SYSTEM_STEP_EXECUTION_QUEUE = "system-step-execution"

/**
 * Queue name for notification-delivery jobs.
 * These jobs deliver one queued notification per recipient and channel.
 */
export const NOTIFICATION_DELIVERY_QUEUE = "notification-delivery"

/**
 * Queue name for upload-complete jobs.
 * These jobs mark files as uploaded after S3 notifies us of completion.
 */
export const UPLOAD_COMPLETE_QUEUE = "upload-complete"
