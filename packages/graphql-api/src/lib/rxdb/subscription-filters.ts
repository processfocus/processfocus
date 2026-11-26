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
  Step as AuthStep,
  AuthorizationService,
  type DelegationPrincipal,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
} from "@pf/auth-policy"
import {
  ProcessCollectionQueries,
  StepRoleQueries,
  TodoQueries,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import type { Process, Todo } from "@pf/graphql-schema"
import { checkExecutionAbandonAuthorization } from "@pf/process-execution/authorization"
import { hasPendingSystemStartRestartDispatch } from "@pf/process-execution/recovery"
import {
  canPrincipalSkipScheduleWaits,
  tryPublicCompletionCorrectionAuthorization,
} from "../authorization"
import type { DraftProcessExecutionEventDocument } from "../draft-process-events"
import type { ExecutionEventDocument } from "../execution-events"
import { canSaveStartForm } from "./draft-process-execution"
import { mapProcessMetadataToGraphql } from "./process"
import {
  type ProcessReplicationPrincipal,
  replicatedProcessRows,
} from "./process-visibility"
import { withProcessVisibilityTransaction } from "./process-visibility-transaction"

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
        canComplete = yield* auth.canCompleteStep(
          principal,
          new AuthStep({
            stepPath: row.stepPath,
            rolePath,
            processPath: row.processPath,
            orgUnitId: row.processOrgUnitPath,
            startsProcess: stepRoleInfo.startsProcess,
            embedded: stepRoleInfo.embedded,
          }),
          {
            todoId: row.id,
            assignedToProviderUserEmail: row.assignedToProviderUserEmail,
          },
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
        doc.startedByServiceAccountId,
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
  principal: ProcessReplicationPrincipal,
) =>
  withProcessVisibilityTransaction(
    Effect.gen(function* () {
      const queries = yield* ProcessCollectionQueries
      // Events are notifications, not authoritative snapshots. Reload so a late
      // revoke event cannot overwrite a newer grant (or leak old protected data).
      const current = yield* queries.getProcessMetadata(
        documents.map((doc) => doc.id),
      )
      const snapshots = new Map(documents.map((doc) => [doc.id, doc]))
      const rows = yield* replicatedProcessRows(principal, current)
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const doc = yield* mapProcessMetadataToGraphql(row)
          const canSkipScheduleWaits = row.deleted
            ? false
            : yield* canPrincipalSkipScheduleWaits(principal, row.path)
          const snapshot = snapshots.get(row.id)
          const result: Process = {
            ...doc,
            // Statistics belong to the shared event snapshot. Keep its revision
            // for live documents so stale statistics cannot advance a checkpoint.
            updatedAt: row.deleted
              ? row.updatedAt
              : (snapshot?.updatedAt ?? row.updatedAt),
            activeInstances: row.deleted ? 0 : (snapshot?.activeInstances ?? 0),
            duration: row.deleted
              ? "Unknown"
              : (snapshot?.duration ?? "Unknown"),
            canSkipScheduleWaits,
          }
          return result
        }),
      )
    }),
  )

/**
 * Filter draft process executions by authorization.
 * Saved form values go only to their owner, who must still be allowed to
 * start the process.
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

      const allowed = yield* canSaveStartForm(
        principal,
        doc.startStepPath,
        stepRolesMap.get(doc.startStepPath),
      )
      if (allowed) {
        authorizedDocs.push(doc)
      }
    }

    return authorizedDocs
  })
