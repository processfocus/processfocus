import { Schema as ES } from "effect"

/**
 * Base schema that all RxDB documents must implement.
 * Provides the required fields for RxDB replication protocol.
 */
export const RxDbDocumentSchema = ES.Struct({
  id: ES.String.pipe(ES.maxLength(41)), // RxDB requires maxLength on primary key
  updatedAt: ES.Number, // Unix timestamp in milliseconds
  // Soft deletes are handled internally by RxDb and should not be part of our schema
  // deleted: ES.Boolean,
})

/**
 * Schema for OrgUnit nested in Process documents.
 */
export const OrgUnitSchema = ES.Struct({
  id: ES.String,
  name: ES.String,
  level: ES.String,
})

/**
 * Schema for draft process execution documents.
 * Tracks user progress through a business process before submission.
 */
export const DraftProcessExecutionSchema = ES.Struct({
  ...RxDbDocumentSchema.fields,
  processId: ES.String,
  name: ES.String,
  startStepPath: ES.String, // Path to the start step
  state: ES.Record({ key: ES.String, value: ES.Unknown }), // Record<string, unknown>
  fieldsCompleted: ES.Int,
  totalFields: ES.Int,
  lastSaved: ES.DateTimeUtc, // ISO date-time string
})

/**
 * Schema for process documents.
 * Represents available business processes users can start.
 */
export const ProcessSchema = ES.Struct({
  canSkipScheduleWaits: ES.optional(ES.Boolean),
  ...RxDbDocumentSchema.fields,
  name: ES.String,
  path: ES.String,
  activeInstances: ES.Int,
  category: ES.String,
  duration: ES.String,
  formFieldCount: ES.Int,
  purpose: ES.String,
  isFavorite: ES.Boolean,
  orgUnit: OrgUnitSchema,
  startStepPath: ES.String, // Path to the start step (required - processes without start steps are invalid)
})

/**
 * Schema for a summary item displayed on todo cards.
 */
export const TodoSummaryItemSchema = ES.Struct({
  label: ES.String,
  value: ES.String,
})

/**
 * Task priority levels for todos.
 */
export const TaskPrioritySchema = ES.Literal("High", "Medium", "Low")
export type TaskPriority = typeof TaskPrioritySchema.Type

/**
 * Schema for todo documents.
 * Represents tasks assigned to users from process executions.
 */
export const TodoSchema = ES.Struct({
  ...RxDbDocumentSchema.fields,
  // Core identifiers
  processExecutionId: ES.String,
  flowId: ES.String,

  // Denormalized display fields (from joins)
  processName: ES.String,
  stepName: ES.String,
  stepPath: ES.String, // Path to the step for schema lookup (e.g., "engineering/bug-report-fix/Report bug")
  role: ES.String,
  description: ES.String,

  // Status and priority
  status: ES.Literal("Active", "Completed", "Correction Required"),
  priority: TaskPrioritySchema,

  // Timestamps (frontend computes display strings)
  assignedAt: ES.DateTimeUtc,
  dueAt: ES.optional(ES.DateTimeUtc),

  // Form metadata
  formComplexity: ES.String, // Simple, Medium, Complex

  // Summary items computed from process state
  summary: ES.Array(TodoSummaryItemSchema),
})

export const ProviderUserSchema = ES.Struct({
  id: ES.String,
  firstName: ES.String,
  lastName: ES.String,
  picture: ES.String,
  orgUnit: ES.String,
})

/**
 * Schema for role in execution steps.
 */
export const RoleSchema = ES.Struct({
  id: ES.String,
  name: ES.String,
})

/**
 * Schema to represent steps in an execution. We have three kind of steps:
 * - Completed (and we know what path was followed).
 * - Active (current to do).
 * - Future (somewhat hypothetical as we cannot predict all paths for complex processes).
 */
export const ExecutionStepSchema = ES.Struct({
  id: ES.String,
  name: ES.String,
  path: ES.String,
  status: ES.Literal(
    "Completed",
    "Waiting",
    "Potential",
    "Failed",
    "Correction Required",
    "Not started",
  ),
  failureReason: ES.optional(ES.String),
  notStartedReason: ES.optional(ES.String),
  role: ES.optional(RoleSchema),
  submittedViaEmbeddedForm: ES.optional(ES.Boolean),
  externalSubmitterEmail: ES.optional(ES.String),
  assignedProviderUserEmail: ES.optional(ES.String),
  providerUser: ES.optional(ProviderUserSchema),
  startedAt: ES.optional(ES.DateTimeUtc), // ISO date-time string (todo created_at)
  completedAt: ES.optional(ES.DateTimeUtc), // ISO date-time string (todo updated_at when completed)
})

/**
 * Schema for execution documents.
 * Represents live process executions visible to all org users.
 */
export const ExecutionSchema = ES.Struct({
  withoutWaiting: ES.optional(ES.Boolean),
  ...RxDbDocumentSchema.fields,
  processStateId: ES.String,
  processName: ES.String,
  processPath: ES.String,
  canAbandonExecution: ES.optional(ES.Boolean),
  canRestartExecution: ES.optional(ES.Boolean),
  status: ES.Literal(
    "Running",
    "Completed",
    "Failed",
    "Abandoned",
    "Not started",
  ),
  failureReason: ES.optional(ES.String),
  abandonedReason: ES.optional(ES.String),
  notStartedReason: ES.optional(ES.String),
  startedAt: ES.DateTimeUtc, // ISO date-time string
  finishedAt: ES.optional(ES.DateTimeUtc), // ISO date-time string
  durationMs: ES.optional(ES.Number),
  steps: ES.Array(ExecutionStepSchema),
  completedSteps: ES.Int, // Count of completed todos
  totalSteps: ES.Int, // Count of total flows in process
  estimatedCompletionAt: ES.optional(ES.DateTimeUtc), // Calculated from typical duration midpoint
  slaWarningAt: ES.optional(ES.DateTimeUtc), // Calculated from process SLA warning threshold
  slaTargetAt: ES.optional(ES.DateTimeUtc), // Calculated from process SLA settings
})

/**
 * Map of all RxDB collections.
 * Add new collections here to have them included in GraphQL generation.
 */
export const RxDbCollections = {
  DraftProcessExecution: DraftProcessExecutionSchema,
  Execution: ExecutionSchema,
  Process: ProcessSchema,
  Todo: TodoSchema,
} as const
