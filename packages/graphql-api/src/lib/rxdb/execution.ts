import type { SqlError } from "@effect/sql/SqlError"
import { Context, DateTime, Effect, Layer, Option, type Schema } from "effect"
import type { BusinessCalendarError } from "@pf/business-calendar"
import {
  type ExecutionListQuery,
  ExecutionQueries,
  type ExecutionRow,
  ProviderUserQueries,
  type TodoStepRow,
  decodeDelegationAudit,
  delegationAuditLabel,
} from "@pf/graphql-db-operations"
import type {
  Execution,
  ExecutionInputPushRowT0NewDocumentStateT0,
} from "@pf/graphql-schema"
import {
  type Form,
  type Organisation,
  OrganisationProvider,
  type StepMeta,
  buildFlowContext,
  normalizePath,
  toConstructPath,
} from "@pf/process"
import type { ExecutionEventDocument } from "../execution-events"
import {
  type InvalidCalendarDataError,
  type InvalidSlaUnitError,
  SlaCalculationService,
  type SlaTargets,
} from "../sla-calculation-service"
import type { RxDbCollectionOps } from "./collection-ops"

/**
 * Step data for GraphQL output.
 */
interface ExecutionStepData {
  id: string
  name: string
  path: string
  status:
    | "Completed"
    | "Waiting"
    | "Potential"
    | "Failed"
    | "Correction Required"
    | "Not started"
  failureReason: string | null
  notStartedReason?: string | null
  roleId: string | null
  roleName: string | null
  roleOrgUnitPath: string | null // org unit path of the role (for authorization)
  completingRoleId: string | null // from to_do.completed_by_role
  completingRoleName: string | null
  externalSubmitterEmail: string | null
  providerUserId: string | null
  providerUserFirstName: string | null
  providerUserLastName: string | null
  providerUserPicture: string | null
  providerUserOrgUnit: string | null
  assignedProviderUserEmail: string | null
  startedAt: string | null // ISO date-time string (todo created_at)
  completedAt: string | null // ISO date-time string (todo updated_at when completed)
}

/**
 * Assembled execution with steps and computed fields.
 */
export interface AssembledExecution {
  execution: ExecutionRow
  steps: ExecutionStepData[]
  completedSteps: number
  totalSteps: number
  slaTargets: SlaTargets
}

export type ExecutionStatus =
  | "Running"
  | "Completed"
  | "Failed"
  | "Abandoned"
  | "Not started"

type MaybeEffect<T> = T | Effect.Effect<T, unknown, unknown>

const resolveMaybeEffect = <T>(value: MaybeEffect<T>) =>
  Effect.isEffect(value) ? value : Effect.succeed(value)

export const publicCompletionRecipientEmail = (
  org: Organisation,
  stepPath: string,
  state: Record<string, unknown>,
  execution: ExecutionRow,
  item: Record<string, unknown> | unknown[] | null,
) =>
  Effect.gen(function* () {
    const resolvedForm = org.formByPath(stepPath)
    if (!resolvedForm) return null

    const form = resolvedForm as Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields,
      string,
      unknown,
      boolean
    >
    const publicCompletion = form.publicCompletion
    if (!publicCompletion) return null

    // Waiting todos have not completed any step metadata yet; public-completion
    // recipient callbacks in current processes use state/process data only.
    const ctx = buildFlowContext(
      execution.id,
      DateTime.unsafeMake(execution.startedAt),
      [],
    )
    const recipient = yield* resolveMaybeEffect(
      publicCompletion.recipient(state, ctx, item ?? undefined),
    )

    return typeof recipient === "string" ? recipient : recipient.email
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning("Unable to resolve public completion recipient", {
        executionId: execution.id,
        stepPath,
        cause,
      }).pipe(Effect.as(null)),
    ),
  ) as Effect.Effect<string | null, never, never>

/**
 * Walk graph from starting step paths to find all reachable steps.
 * Used to determine potential future steps in a running process.
 *
 * Paths from DB have leading slashes, but graph nodes use construct paths
 * (no leading slash). We convert DB paths to construct paths for graph lookups.
 */
const walkGraphFromSteps = (
  startPaths: string[],
  org: Organisation,
): string[] => {
  const firstPath = startPaths[0]
  if (!firstPath) return []

  // Find the process from first step (stepByPath handles leading slash)
  const firstStep = org.stepByPath(firstPath)
  if (!firstStep) return []

  const graph = firstStep.process.getGraph()
  const visited = new Set<string>()
  const result: string[] = []
  // Convert DB paths to construct paths for graph lookups
  const queue = startPaths.map(toConstructPath)

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    // Skip the virtual end node (we can encounter it when a step has .end())
    if (org.isEndNode(current)) {
      continue
    }

    visited.add(current)
    result.push(current)

    // Add all outgoing neighbors (graph uses construct paths)
    for (const neighbor of graph.outNeighbors(current)) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor)
      }
    }
  }

  return result
}

/**
 * Result of assembling steps for an execution.
 * Includes the steps and a corrected status (for old data without finishedAt).
 */
interface AssembleStepsResult {
  steps: ExecutionStepData[]
  /** Corrected status: "Completed" if no waiting todos and no potential steps */
  correctedStatus: ExecutionStatus
}

const epochMsToIsoOrNull = (
  epochMs: number | null | undefined,
): string | null => {
  if (epochMs == null || !Number.isFinite(epochMs) || epochMs <= 0) {
    return null
  }

  return DateTime.formatIso(DateTime.unsafeMake(epochMs))
}

/**
 * Assemble steps for an execution using todos and org graph walking.
 *
 * Logic:
 * 0. Always prepend the start step as first completed step (from execution.startStep*)
 * 1. Add completed steps (from todos where completed=true)
 * 2. Add waiting steps (from todos where completed=false)
 * 3. For in-progress executions, walk graph from current position to find potential steps
 *    - If there are waiting todos, start from those
 *    - If no waiting todos but execution is in-progress, start from last completed todo
 * 4. If status is "Running" but no waiting todos and no potential steps, correct to "Completed"
 *    (handles old data without finishedAt)
 */
export const assembleSteps = (
  execution: ExecutionRow,
  todos: TodoStepRow[],
  org: Organisation,
): AssembleStepsResult => {
  const executionTodos = todos
    .filter((t) => t.executionId === execution.id)
    .sort((a, b) => a.updatedAt - b.updatedAt)

  const steps: ExecutionStepData[] = []
  const addedPaths = new Set<string>()
  const addedKeys = new Set<string>()
  const isSystemStart = execution.startStepRoleId === null
  const startStepStatus: ExecutionStepData["status"] = (() => {
    if (!isSystemStart) return "Completed"

    switch (execution.status) {
      case "Completed":
        return "Completed"
      case "Failed":
        return "Failed"
      case "Not started":
        return execution.systemStartCompleted ? "Completed" : "Not started"
      case "Abandoned":
        // Step status has no Abandoned variant; use Failed so abandoned
        // system-start executions do not look waiting or completed.
        return "Failed"
      case "Running":
        return "Waiting"
      default:
        return "Waiting"
    }
  })()

  // Helper to add a step if not already added.
  // Graph/start/potential steps dedupe on construct path. Todo-backed steps
  // (including forEach siblings) dedupe on todo id so a completed item and a
  // failed item of the same step can both remain visible.
  const addStep = (step: ExecutionStepData, uniqueKey?: string) => {
    const pathKey = toConstructPath(step.path)
    const key = uniqueKey ?? pathKey
    if (addedKeys.has(key)) return
    addedKeys.add(key)
    addedPaths.add(pathKey)
    steps.push({ ...step, path: normalizePath(step.path) })
  }

  const startPathKey = toConstructPath(execution.startStepPath)
  const addTodoStep = (step: ExecutionStepData, todoId: string) => {
    // The start step is prepended from execution metadata; a todo for that
    // same path is not a second timeline entry.
    if (toConstructPath(step.path) === startPathKey) return
    addStep(step, todoId)
  }

  // 0. Prepend the start step as first completed step
  // Human start steps are completed immediately. System start steps have no
  // todo, so they mirror the execution status until the start job finishes.
  addStep({
    id: execution.startStepId,
    name: execution.startStepName,
    path: execution.startStepPath,
    status: startStepStatus,
    failureReason:
      startStepStatus === "Failed" ? execution.abandonedReason : null,
    notStartedReason:
      startStepStatus === "Not started"
        ? (execution.notStartedReason ?? null)
        : null,
    roleId: execution.startStepRoleId,
    roleName: execution.startStepRoleName,
    roleOrgUnitPath: execution.startStepRoleOrgUnitPath,
    completingRoleId: execution.startedByRoleId,
    completingRoleName: execution.startedByRoleName,
    externalSubmitterEmail: execution.startStepExternalParticipantEmail,
    providerUserId: execution.startedById,
    providerUserFirstName:
      delegationAuditLabel(execution.createdBy ?? "") ??
      execution.startedByFirstName,
    providerUserLastName: delegationAuditLabel(execution.createdBy ?? "")
      ? null
      : execution.startedByLastName,
    providerUserPicture: execution.startedByPicture,
    providerUserOrgUnit: execution.startedByOrgUnit,
    assignedProviderUserEmail: null,
    // Start step: started when process_state was created, completed when execution started
    startedAt: execution.processStateCreatedAt,
    completedAt: isSystemStart
      ? startStepStatus === "Completed" || startStepStatus === "Failed"
        ? // Old rows may have a terminal status without finishedAt; startedAt is
          // the best available completion timestamp for those legacy records.
          (execution.finishedAt ?? execution.startedAt)
        : null
      : execution.startedAt,
  })

  // 1. Add completed steps (exclude those with a failureReason, e.g. abandoned todos)
  for (const todo of executionTodos.filter(
    (t) => t.completed && t.failureReason == null && t.notStartedReason == null,
  )) {
    addTodoStep(
      {
        id: todo.todoId,
        name: todo.stepName,
        path: todo.stepPath,
        status: "Completed",
        failureReason: null,
        roleId: todo.roleId,
        roleName: todo.roleName,
        roleOrgUnitPath: todo.roleOrgUnitPath,
        completingRoleId: todo.completingRoleId,
        completingRoleName: todo.completingRoleName,
        externalSubmitterEmail: todo.externalParticipantEmail,
        providerUserId: todo.providerUserId,
        providerUserFirstName:
          delegationAuditLabel(todo.updatedBy ?? "") ??
          todo.providerUserFirstName,
        providerUserLastName: delegationAuditLabel(todo.updatedBy ?? "")
          ? null
          : todo.providerUserLastName,
        providerUserPicture: todo.providerUserPicture,
        providerUserOrgUnit: todo.providerUserOrgUnit,
        assignedProviderUserEmail: todo.assignedProviderUserEmail,
        startedAt: epochMsToIsoOrNull(todo.createdAt),
        completedAt:
          epochMsToIsoOrNull(todo.updatedAt) ??
          epochMsToIsoOrNull(todo.createdAt),
      },
      todo.todoId,
    )
  }

  // 2. Add failed steps (includes abandoned todos that have both _deleted and failureReason)
  const failedTodos = executionTodos.filter(
    (t) => t.failureReason != null || t.notStartedReason != null,
  )
  for (const todo of failedTodos) {
    addTodoStep(
      {
        id: todo.todoId,
        name: todo.stepName,
        path: todo.stepPath,
        status: todo.notStartedReason != null ? "Not started" : "Failed",
        failureReason: todo.failureReason,
        notStartedReason: todo.notStartedReason ?? null,
        roleId: todo.roleId,
        roleName: todo.roleName,
        roleOrgUnitPath: todo.roleOrgUnitPath,
        completingRoleId: todo.completingRoleId,
        completingRoleName: todo.completingRoleName,
        externalSubmitterEmail: todo.externalParticipantEmail,
        providerUserId: todo.providerUserId,
        providerUserFirstName:
          delegationAuditLabel(todo.updatedBy ?? "") ??
          todo.providerUserFirstName,
        providerUserLastName: delegationAuditLabel(todo.updatedBy ?? "")
          ? null
          : todo.providerUserLastName,
        providerUserPicture: todo.providerUserPicture,
        providerUserOrgUnit: todo.providerUserOrgUnit,
        assignedProviderUserEmail: todo.assignedProviderUserEmail,
        startedAt: epochMsToIsoOrNull(todo.createdAt),
        completedAt:
          epochMsToIsoOrNull(todo.updatedAt) ??
          epochMsToIsoOrNull(todo.createdAt),
      },
      todo.todoId,
    )
  }

  // 3. Add waiting steps
  const correctionRequiredTodos = executionTodos.filter(
    (t) => !t.completed && t.correctionRequiredAt != null,
  )
  for (const todo of correctionRequiredTodos) {
    addTodoStep(
      {
        id: todo.todoId,
        name: todo.stepName,
        path: todo.stepPath,
        status: "Correction Required",
        failureReason: todo.correctionFailureReason,
        roleId: todo.roleId,
        roleName: todo.roleName,
        roleOrgUnitPath: todo.roleOrgUnitPath,
        completingRoleId: todo.completingRoleId,
        completingRoleName: todo.completingRoleName,
        externalSubmitterEmail: todo.externalParticipantEmail,
        providerUserId: todo.providerUserId,
        providerUserFirstName: todo.providerUserFirstName,
        providerUserLastName: todo.providerUserLastName,
        providerUserPicture: todo.providerUserPicture,
        providerUserOrgUnit: todo.providerUserOrgUnit,
        assignedProviderUserEmail: todo.assignedProviderUserEmail,
        startedAt: epochMsToIsoOrNull(todo.createdAt),
        completedAt: null,
      },
      todo.todoId,
    )
  }

  const waitingTodos = executionTodos.filter(
    (t) =>
      !t.completed &&
      t.failureReason == null &&
      t.notStartedReason == null &&
      t.correctionRequiredAt == null,
  )
  for (const todo of waitingTodos) {
    addTodoStep(
      {
        id: todo.todoId,
        name: todo.stepName,
        path: todo.stepPath,
        status: "Waiting",
        failureReason: null,
        roleId: todo.roleId,
        roleName: todo.roleName,
        roleOrgUnitPath: todo.roleOrgUnitPath,
        completingRoleId: todo.completingRoleId,
        completingRoleName: todo.completingRoleName,
        externalSubmitterEmail: todo.externalParticipantEmail,
        providerUserId: todo.providerUserId,
        providerUserFirstName: todo.providerUserFirstName,
        providerUserLastName: todo.providerUserLastName,
        providerUserPicture: todo.providerUserPicture,
        providerUserOrgUnit: todo.providerUserOrgUnit,
        assignedProviderUserEmail: todo.assignedProviderUserEmail,
        startedAt: epochMsToIsoOrNull(todo.createdAt),
        completedAt: null, // Not completed yet
      },
      todo.todoId,
    )
  }

  const hasFailedSteps = failedTodos.length > 0
  const activeTodos = [...correctionRequiredTodos, ...waitingTodos]

  // 4. For in-progress executions, walk graph to find potential steps.
  // A Failed/Abandoned execution does not grow more work. A still-open
  // execution with a failed step and waiting recovery (onError) does.
  let hasPotentialSteps = false
  if (
    execution.status !== "Completed" &&
    execution.status !== "Failed" &&
    execution.status !== "Abandoned" &&
    execution.status !== "Not started" &&
    (!hasFailedSteps || activeTodos.length > 0)
  ) {
    let startPaths: string[] = []

    if (activeTodos.length > 0) {
      // Start from all active steps, including correction-required work.
      startPaths = activeTodos.map((t) => t.stepPath)
    } else {
      // No waiting todos - start from last completed step
      const completedTodos = executionTodos.filter((t) => t.completed)
      if (completedTodos.length > 0) {
        const lastCompleted = completedTodos[completedTodos.length - 1]
        if (lastCompleted) {
          startPaths = [lastCompleted.stepPath]
        }
      } else {
        // No completed todos either - start from the start step
        startPaths = [execution.startStepPath]
      }
    }

    if (startPaths.length > 0) {
      // Walk the graph from starting points
      const reachablePaths = walkGraphFromSteps(startPaths, org)

      // Add potential steps (those not already in our list)
      for (const path of reachablePaths) {
        if (addedPaths.has(path)) continue

        // Get step info from the org graph
        const step = org.stepByPath(path)
        if (!step) continue

        hasPotentialSteps = true
        const potentialStepRole = step.props.role
        // Get org unit path from role's org unit (add leading slash for consistency)
        const roleOrgUnitPath = potentialStepRole?.orgUnit.node.path
          ? `/${potentialStepRole.orgUnit.node.path}/`
          : null
        addStep({
          id: `potential-${path}`, // Use path-based ID for potential steps
          name: step.props.name ?? path.split("/").pop() ?? path,
          path,
          status: "Potential",
          failureReason: null,
          roleId: potentialStepRole?.node.id ?? null,
          roleName: potentialStepRole?.name ?? null,
          roleOrgUnitPath,
          completingRoleId: null,
          completingRoleName: null,
          externalSubmitterEmail: null,
          providerUserId: null,
          providerUserFirstName: null,
          providerUserLastName: null,
          providerUserPicture: null,
          providerUserOrgUnit: null,
          assignedProviderUserEmail: null,
          startedAt: null,
          completedAt: null,
        })
      }
    }
  }

  // 5. Determine corrected status
  // - DB Failed/Abandoned/Completed is authoritative
  // - A failed todo with no remaining work is Failed (legacy rows that never
  //   closed the execution)
  // - A failed todo with waiting recovery work stays Running
  // - Else, if status is "Running" but no waiting todos and no potential steps,
  //   it's actually completed (handles old data without finishedAt set)
  const correctedStatus: ExecutionStatus =
    execution.status === "Not started"
      ? "Not started"
      : execution.status === "Abandoned"
        ? "Abandoned"
        : execution.status === "Completed"
          ? "Completed"
          : execution.status === "Failed"
            ? "Failed"
            : hasFailedSteps && activeTodos.length === 0
              ? "Failed"
              : activeTodos.length === 0 &&
                  !hasPotentialSteps &&
                  execution.startStepRoleId != null
                ? "Completed"
                : "Running"

  return { steps, correctedStatus }
}

/**
 * Convert SLA value and unit to milliseconds.
 * @param value - The numeric SLA value
 * @param unit - The SLA unit (minutes, businessHours, businessDays, businessWeeks)
 * @returns Duration in milliseconds
 */
export const slaToMs = (value: number, unit: string): number => {
  switch (unit) {
    case "minutes":
      return value * 60 * 1000
    case "businessHours":
      return value * 60 * 60 * 1000
    case "businessDays":
      return value * 8 * 60 * 60 * 1000 // 8 business hours per day
    case "businessWeeks":
      return value * 5 * 8 * 60 * 60 * 1000 // 5 days * 8 hours
    default:
      return value * 60 * 60 * 1000 // Default to hours
  }
}

/**
 * Calculate SLA target time.
 * @param startedAt - ISO date string when execution started
 * @param slaValue - SLA value
 * @param slaUnit - SLA unit (businessHours, businessDays, businessWeeks)
 * @returns ISO date string or null if no SLA configured
 */
export const calculateSlaTarget = (
  startedAt: string,
  slaValue: number | null,
  slaUnit: string | null,
): string | null => {
  if (slaValue == null || slaUnit == null) return null
  const startedAtDt = DateTime.unsafeMake(startedAt)
  const slaMs = slaToMs(slaValue, slaUnit)
  return DateTime.formatIso(DateTime.add(startedAtDt, { millis: slaMs }))
}

/**
 * Calculate SLA warning time (when warning threshold is reached).
 * @param startedAt - ISO date string when execution started
 * @param slaValue - SLA value
 * @param slaUnit - SLA unit (businessHours, businessDays, businessWeeks)
 * @param warningPercent - Warning threshold percentage (0-100), defaults to 80
 * @returns ISO date string or null if no SLA configured
 */
export const calculateSlaWarning = (
  startedAt: string,
  slaValue: number | null,
  slaUnit: string | null,
  warningPercent: number | null,
): string | null => {
  // All three values must be configured - no default for warning threshold
  if (slaValue == null || slaUnit == null || warningPercent == null) return null
  const startedAtDt = DateTime.unsafeMake(startedAt)
  const slaMs = slaToMs(slaValue, slaUnit)
  const warningMs = slaMs * (warningPercent / 100)
  return DateTime.formatIso(DateTime.add(startedAtDt, { millis: warningMs }))
}

/**
 * Map assembled execution to GraphQL document type.
 */
const mapToGraphql = (
  assembled: AssembledExecution,
): ExecutionEventDocument => {
  const { execution, slaTargets } = assembled
  const isRunning = execution.status === "Running"

  const firstFailedStep = assembled.steps.find((s) => s.status === "Failed")

  return {
    id: execution.id,
    startedByEmail: execution.startedByEmail,
    startedByRolePath: execution.startedByRolePath,
    stepOrgUnitPaths: assembled.steps.flatMap((step) =>
      (step.status === "Completed" ||
        step.status === "Waiting" ||
        step.status === "Correction Required") &&
      step.roleOrgUnitPath
        ? [step.roleOrgUnitPath]
        : [],
    ),
    processStateId: execution.processStateId,
    withoutWaiting: execution.withoutWaiting ?? false,
    processName: execution.processName,
    processPath: execution.processPath,
    // Principal-specific permission fields are patched by pull/stream auth paths.
    canAbandonExecution: false,
    canRestartExecution: false,
    status: execution.status,
    // A failed step is more specific than the execution-level failure recorded
    // for system-start failures before any todo exists.
    failureReason:
      firstFailedStep?.failureReason ??
      (execution.status === "Failed" ? execution.abandonedReason : null),
    abandonedReason:
      execution.status === "Abandoned" ? execution.abandonedReason : null,
    notStartedReason: execution.notStartedReason ?? null,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    completedSteps: assembled.completedSteps,
    totalSteps: assembled.totalSteps,
    durationMs: execution.durationMs,
    updatedAt: execution.updatedAt,
    deleted: execution.deleted,
    // Use pre-calculated values from SlaCalculationService (business calendar aware)
    // Only show estimated completion for running executions
    estimatedCompletionAt: isRunning ? slaTargets.estimatedCompletionAt : null,
    slaWarningAt: slaTargets.slaWarningAt,
    slaTargetAt: slaTargets.slaTargetAt,
    steps: assembled.steps.map((step) => ({
      id: step.id,
      name: step.name,
      path: step.path,
      status: step.status,
      failureReason: step.failureReason,
      notStartedReason: step.notStartedReason ?? null,
      role: step.completingRoleId
        ? {
            id: step.completingRoleId,
            name: step.completingRoleName ?? "",
          }
        : step.roleId
          ? {
              id: step.roleId,
              name: step.roleName ?? "",
            }
          : null,
      submittedViaEmbeddedForm:
        step.path === execution.startStepPath && execution.startStepEmbedded,
      externalSubmitterEmail: step.externalSubmitterEmail,
      assignedProviderUserEmail: step.assignedProviderUserEmail,
      providerUser: step.providerUserId
        ? {
            id: step.providerUserId,
            firstName: step.providerUserFirstName ?? "",
            lastName: step.providerUserLastName ?? "",
            picture: step.providerUserPicture ?? "",
            orgUnit: step.providerUserOrgUnit ?? "",
          }
        : null,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
    })),
  }
}

/**
 * RxDB collection operations for Execution.
 *
 * This service adapts the ExecutionQueries to the generic
 * RxDbCollectionOps interface, enabling use with the generic resolvers.
 *
 * Read-only collection: Push operations are noop.
 */
type ExecutionCollectionContract = RxDbCollectionOps<
  AssembledExecution,
  Execution,
  ExecutionInputPushRowT0NewDocumentStateT0
>

export class ExecutionCollectionOps extends Context.Tag(
  "@pf/graphql-api/ExecutionCollectionOps",
)<
  ExecutionCollectionOps,
  Omit<ExecutionCollectionContract, "pull"> & {
    readonly pull: (
      ...args: Parameters<ExecutionQueries["Type"]["pullExecution"]>
    ) => ReturnType<ExecutionCollectionContract["pull"]>

    readonly list: (
      query: ExecutionListQuery,
    ) => Effect.Effect<
      AssembledExecution[],
      | SqlError
      | InvalidCalendarDataError
      | InvalidSlaUnitError
      | BusinessCalendarError
    >
  }
>() {}

/**
 * Live implementation that delegates to ExecutionQueries.
 * Assembles steps using todos + org graph walking.
 * Insert/update/delete operations return noop (read-only collection).
 */
export const ExecutionCollectionOpsLive = Layer.effect(
  ExecutionCollectionOps,
  Effect.gen(function* () {
    const queries = yield* ExecutionQueries
    const providerUsers = yield* ProviderUserQueries
    const { organisation: org } = yield* OrganisationProvider
    const slaService = yield* SlaCalculationService

    /**
     * Fetch executions and assemble with steps.
     */
    const fetchAndAssemble = (
      executionsEffect: Effect.Effect<ExecutionRow[], SqlError>,
    ): Effect.Effect<
      AssembledExecution[],
      | SqlError
      | InvalidCalendarDataError
      | InvalidSlaUnitError
      | BusinessCalendarError
    > =>
      Effect.gen(function* () {
        const executions = yield* executionsEffect
        if (executions.length === 0) return []

        // Batch fetch todos for all executions
        const executionIds = executions.map((e) => e.id)
        const todos = yield* queries.getTodosForExecutions(executionIds)

        // Batch calculate SLA targets and estimated completion using business calendars
        const slaInputs = executions.map((e) => ({
          id: e.id,
          startedAt: e.startedAt,
          orgUnitId: e.processOrgUnitId,
          slaValue: e.processSlaValue,
          slaUnit: e.processSlaUnit,
          slaWarning: e.processSlaWarning,
          typicalDurationMinMs: e.typicalDurationMinMs,
          typicalDurationMaxMs: e.typicalDurationMaxMs,
        }))
        const slaTargetsMap = yield* slaService.calculateSlaTargets(slaInputs)

        // Assemble each execution with steps and SLA targets
        return yield* Effect.forEach(
          executions,
          (execution) =>
            Effect.gen(function* () {
              const { steps: assembledSteps, correctedStatus } = assembleSteps(
                execution,
                todos,
                org,
              )
              const steps = yield* Effect.forEach(assembledSteps, (step) =>
                Effect.gen(function* () {
                  if (step.status !== "Failed" || step.providerUserId !== null)
                    return step

                  const todo = todos.find((todo) => todo.todoId === step.id)
                  if (!todo || todo.completedByUserId !== null) return step
                  const audit = decodeDelegationAudit(todo.updatedBy ?? "")
                  if (Option.isNone(audit)) return step

                  // Audit ownerUserId is user.id, not provider_user.id. Project
                  // the initiating business owner, never a worker completer.
                  const owner = yield* providerUsers.queryProviderUserByUserId(
                    audit.value.ownerUserId,
                  )
                  if (Option.isNone(owner)) return step
                  return {
                    ...step,
                    providerUserId: owner.value.id,
                    providerUserFirstName:
                      todo.failureReason === "Execution abandoned"
                        ? (delegationAuditLabel(todo.updatedBy ?? "") ?? null)
                        : `${delegationAuditLabel(todo.updatedBy ?? "")} (initiated work)`,
                    providerUserLastName: null,
                  }
                }),
              )
              const hasWaitingStepsWithoutExternalSubmitter = steps.some(
                (step) =>
                  step.status === "Waiting" &&
                  step.externalSubmitterEmail == null,
              )
              const state = hasWaitingStepsWithoutExternalSubmitter
                ? yield* queries.getProcessStateByExecutionId(execution.id)
                : null
              const waitingTodosByPath = state
                ? new Map(
                    todos
                      .filter(
                        (todo) =>
                          todo.executionId === execution.id &&
                          !todo.completed &&
                          todo.failureReason == null,
                      )
                      .map((todo) => [normalizePath(todo.stepPath), todo]),
                  )
                : new Map<string, TodoStepRow>()
              const enrichedSteps = state
                ? yield* Effect.forEach(steps, (step) =>
                    Effect.gen(function* () {
                      if (
                        step.status !== "Waiting" ||
                        step.externalSubmitterEmail != null
                      ) {
                        return step
                      }

                      const todo = waitingTodosByPath.get(
                        normalizePath(step.path),
                      )
                      const externalSubmitterEmail =
                        yield* publicCompletionRecipientEmail(
                          org,
                          step.path,
                          state,
                          execution,
                          todo?.itemData ?? null,
                        )
                      return externalSubmitterEmail
                        ? { ...step, externalSubmitterEmail }
                        : step
                    }),
                  )
                : steps

              return {
                execution: { ...execution, status: correctedStatus },
                steps: enrichedSteps,
                completedSteps: enrichedSteps.filter(
                  (s) => s.status === "Completed",
                ).length,
                totalSteps: enrichedSteps.length,
                slaTargets: slaTargetsMap.get(execution.id) ?? {
                  slaTargetAt: null,
                  slaWarningAt: null,
                  estimatedCompletionAt: null,
                },
              }
            }),
          { concurrency: 10 },
        )
      })

    return {
      pull: (checkpoint, limit, includeRunning, historySince) =>
        fetchAndAssemble(
          queries.pullExecution(
            checkpoint,
            limit,
            includeRunning,
            historySince,
          ),
        ),

      // Read-only: noop implementations
      insert: () => Effect.succeed("noop"),
      update: () => Effect.succeed("noop"),
      delete: () => Effect.succeed("noop"),

      getByIds: (ids) => fetchAndAssemble(queries.getExecutions(ids)),

      list: (query) => fetchAndAssemble(queries.listExecutions(query)),

      mapToGraphql: (assembled) => Effect.succeed(mapToGraphql(assembled)),
    }
  }),
)
