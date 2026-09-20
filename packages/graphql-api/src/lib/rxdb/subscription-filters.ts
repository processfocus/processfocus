/**
 * Authorization filter functions for RxDB subscription streams.
 *
 * These filters are used by both:
 * - Local runtime: Per-subscriber filtering in subscription resolver
 * - AWS runtime: Per-user filtering before publishing to user channels
 *
 * Each filter mirrors the authorization logic used in pull queries to ensure
 * consistent behavior between initial data fetches and real-time updates.
 */
import { Effect } from "effect"
import {
  Execution as AuthExecution,
  AuthorizationService,
  type DelegationPrincipal,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
  TodoRef,
} from "@pf/auth-policy"
import {
  StepRoleQueries,
  TodoQueries,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import type { Process, Todo } from "@pf/graphql-schema"
import {
  canPrincipalSkipScheduleWaits,
  tryPublicCompletionCorrectionAuthorization,
  trySequentialStepAuthorization,
} from "../authorization"
import type { DraftProcessExecutionEventDocument } from "../draft-process-events"
import { checkExecutionAbandonAuthorization } from "../execution-abandon-authorization"
import type { ExecutionEventDocument } from "../execution-events"
import { hasPendingSystemStartRestartDispatch } from "../execution-restart"
import { getProcessPathFromStepPath } from "../resolver-utils"

const isProviderUserPrincipal = (
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
): principal is ProviderUserPrincipal | DelegationPrincipal =>
  principal.uid.type === "PF::ProviderUser" ||
  principal.uid.type === "PF::Delegation"

/**
 * Filter todos by authorization.
 * Uses the same Cedar complete-on-Todo decision as pullTodo.
 *
 * @param documents - Todo documents to filter
 * @param principal - The user principal performing the action
 * @returns Filtered array of authorized todos
 */
export const filterAuthorizedTodos = (
  documents: readonly Todo[],
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
) =>
  Effect.gen(function* () {
    if (documents.length === 0) {
      return []
    }

    const todoQueries = yield* TodoQueries
    const stepRoleQueries = yield* StepRoleQueries
    const auth = yield* AuthorizationService
    const rows = yield* todoQueries.getTodos(documents.map((doc) => doc.id))
    const rowsById = new Map(rows.map((row) => [row.id, row]))
    const stepRolesMap = yield* stepRoleQueries.queryRolePathsByStepPaths(
      rows.map((row) => row.stepPath),
    )

    const authorizedDocs: Todo[] = []
    for (const doc of documents) {
      const row = rowsById.get(doc.id)
      if (!row) {
        // The event can race with todo deletion; missing rows are not visible.
        continue
      }

      const stepRoleInfo = stepRolesMap.get(row.stepPath) ?? {
        rolePath: row.rolePath,
        supportingRolePaths: [],
        startsProcess: false,
        embedded: false,
      }
      const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)
      const candidateRolePaths =
        rolePathsToTry.length > 0 ? rolePathsToTry : [null]
      if (row.status === "Correction Required") {
        // Correction Todos use their own Cedar action; normal complete auth must
        // not leak them to service accounts or public-completion callers.
        if (!isProviderUserPrincipal(principal)) {
          continue
        }

        const correctionAuthorization =
          yield* tryPublicCompletionCorrectionAuthorization(
            principal,
            row,
            stepRoleInfo,
          )
        if (correctionAuthorization.authorized) {
          authorizedDocs.push(doc)
        }
        continue
      }

      let canComplete = false
      for (const rolePath of candidateRolePaths) {
        canComplete = yield* auth.canCompleteTodo(
          principal,
          new TodoRef(row.id, {
            stepPath: row.stepPath,
            rolePath,
            processPath: row.processPath,
            orgUnitId: row.processOrgUnitPath,
            assignedToProviderUserEmail: row.assignedToProviderUserEmail,
          }),
        )
        if (canComplete) break
      }
      if (canComplete) {
        authorizedDocs.push(doc)
      }
    }

    return authorizedDocs
  })

/**
 * Filter executions by authorization and attach execution capabilities.
 *
 * @param documents - Execution documents to filter
 * @param principal - The user principal performing the action
 * @returns Filtered array of authorized executions
 */
export const filterAuthorizedExecutions = (
  documents: readonly ExecutionEventDocument[],
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
) =>
  Effect.gen(function* () {
    if (documents.length === 0) {
      return []
    }

    const auth = yield* AuthorizationService

    const authorizedDocs: ExecutionEventDocument[] = []
    for (const doc of documents) {
      const resource = new AuthExecution(
        doc.id,
        doc.startedByEmail,
        doc.processPath,
        doc.stepOrgUnitPaths ?? [],
        doc.startedByRolePath,
      )
      const canView = yield* auth.canViewExecution(principal, resource)
      if (canView) {
        // Failed executions, plus Running with a pending external restart
        // outbox (post-commit drain recovery for system-start restarts).
        const canRestartExecution = yield* Effect.gen(function* () {
          if (doc.status === "Failed") {
            return yield* auth.canRestartExecution(principal, resource)
          }
          if (doc.status !== "Running") {
            return false
          }
          if (!(yield* hasPendingSystemStartRestartDispatch(doc.id))) {
            return false
          }
          return yield* auth.canRestartExecution(principal, resource)
        })
        const abandonAuthorization = yield* checkExecutionAbandonAuthorization(
          principal,
          doc.id,
          doc.status,
        )
        authorizedDocs.push({
          ...doc,
          canAbandonExecution: abandonAuthorization.authorized,
          canRestartExecution,
        })
      }
    }

    return authorizedDocs
  })

/**
 * Filter processes by authorization.
 * Uses Cedar policy: principal.roles.contains(resource.role) on start step
 *
 * @param documents - Process documents to filter
 * @param principal - The user principal performing the action
 * @returns Filtered array of authorized processes
 */
export const filterAuthorizedProcesses = (
  documents: readonly Process[],
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
) =>
  Effect.gen(function* () {
    if (documents.length === 0) {
      return []
    }

    const stepRoleQueries = yield* StepRoleQueries
    const auth = yield* AuthorizationService

    // Batch fetch allowed roles for all start steps
    const startStepPaths = documents.map((d) => d.startStepPath)
    const stepRolesMap =
      yield* stepRoleQueries.queryRolePathsByStepPaths(startStepPaths)

    const authorizedDocs: Process[] = []
    for (const doc of documents) {
      const stepRoleInfo = stepRolesMap.get(doc.startStepPath) ?? {
        rolePath: null,
        supportingRolePaths: [],
        embedded: false,
        startsProcess: true,
      }
      const canStart = yield* trySequentialStepAuthorization(
        stepRoleInfo,
        doc.startStepPath,
        doc.path,
        (resource) => auth.canCompleteStep(principal, resource),
      )
      if (canStart) {
        const canSkipScheduleWaits = yield* canPrincipalSkipScheduleWaits(
          principal,
          doc.path,
        )
        authorizedDocs.push({ ...doc, canSkipScheduleWaits })
      }
    }

    return authorizedDocs
  })

/**
 * Filter draft process executions by authorization.
 * Uses Cedar policy: principal.roles.contains(resource.role) on start step
 *
 * This uses the new 'draft' action to authorize viewing/editing drafts.
 *
 * @param documents - DraftProcessExecution documents to filter
 * @param principal - The user principal performing the action
 * @returns Filtered array of authorized draft process executions
 */
export const filterAuthorizedDrafts = (
  documents: readonly DraftProcessExecutionEventDocument[],
  principal: ProviderUserPrincipal | DelegationPrincipal,
) =>
  Effect.gen(function* () {
    if (documents.length === 0) {
      return []
    }

    const stepRoleQueries = yield* StepRoleQueries
    const auth = yield* AuthorizationService

    // Batch fetch allowed roles for all start steps
    const startStepPaths = documents.map((d) => d.startStepPath)
    const stepRolesMap =
      yield* stepRoleQueries.queryRolePathsByStepPaths(startStepPaths)

    const authorizedDocs: DraftProcessExecutionEventDocument[] = []
    const effectiveOwner =
      "owner" in principal ? principal.owner.id : principal.uid.id
    for (const doc of documents) {
      if (
        doc.startedByEmail !== effectiveOwner &&
        doc.startedByUserId !== effectiveOwner
      ) {
        continue
      }

      const stepRoleInfo = stepRolesMap.get(doc.startStepPath) ?? {
        rolePath: null,
        supportingRolePaths: [],
        embedded: false,
        startsProcess: true,
      }
      const processPath = getProcessPathFromStepPath(doc.startStepPath)
      const canDraft = yield* trySequentialStepAuthorization(
        stepRoleInfo,
        doc.startStepPath,
        processPath,
        (resource) => auth.canDraftStep(principal, resource),
      )
      if (canDraft) {
        authorizedDocs.push(doc)
      }
    }

    return authorizedDocs
  })
