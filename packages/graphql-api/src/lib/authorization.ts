import { Effect } from "effect"
import {
  Execution as AuthExecution,
  Step as AuthStep,
  AuthorizationService,
  type DelegationPrincipal,
  ListRef,
  type NonEmptyReadonlyArray,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
} from "@pf/auth-policy"
import {
  type ProcessListRow,
  type StepRoleInfo,
  StepRoleQueries,
  type TodoRow,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import { NotAuthorized } from "@pf/graphql-schema"
import {
  canPrincipalSkipScheduleWaits,
  buildPrincipal as execution_buildPrincipal,
  buildStepPrincipal as execution_buildStepPrincipal,
  canModifyField as execution_canModifyField,
  canSkipScheduleWaits as execution_canSkipScheduleWaits,
  checkPublicCompletionCorrectionAuthorization as execution_checkPublicCompletionCorrectionAuthorization,
  checkStepAuthorization as execution_checkStepAuthorization,
  checkTodoAuthorization as execution_checkTodoAuthorization,
  tryPublicCompletionCorrectionAuthorization,
} from "@pf/process-execution/authorization"
import { executionIdentity } from "./execution-adapter"
import type { AssembledExecution } from "./rxdb/execution"
import { isProviderUserSession } from "./session-guards"
import type { UserContext } from "./types"

/**
 * Preserve the accepted provider-user or delegation actor from request context.
 */
export const buildExecutionAuthorizationResource = (
  row: AssembledExecution,
) => {
  const stepOrgUnitPaths = row.steps.flatMap((step) =>
    (step.status === "Completed" ||
      step.status === "Waiting" ||
      step.status === "Correction Required") &&
    step.roleOrgUnitPath
      ? [step.roleOrgUnitPath]
      : [],
  )

  return new AuthExecution(
    row.execution.id,
    row.execution.startedByEmail,
    row.execution.processPath,
    stepOrgUnitPaths,
    row.execution.startedByRolePath,
    row.execution.startedByServiceAccountId,
  )
}

/** Apply the same canViewExecution decision to list and pull rows. */
export const filterAuthorizedExecutionRows = (
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
  rows: readonly AssembledExecution[],
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const authorizedRows: AssembledExecution[] = []

    for (const row of rows) {
      const canView = yield* auth.canViewExecution(
        principal,
        buildExecutionAuthorizationResource(row),
      )
      if (canView) authorizedRows.push(row)
    }

    return authorizedRows
  })

/**
 * Check if the user is authorized to complete a step (or start a process via its start step).
 * Provider users and service accounts are checked as distinct Cedar principal
 * types. Service accounts need their own explicit permit rules when they are
 * allowed to start or complete a step.
 *
 * Uses sequential trial authorization:
 * 1. Tries the primary role
 * 2. Falls back to supporting roles (in declaration order)
 * 3. None pass → not authorized
 *
 * @returns The role path that authorized the step completion, or NotAuthorized
 */
/**
 * Try each declared role in order, falling back to a roleless step resource
 * when the step has no roles.
 */
export const trySequentialStepAuthorization = <E, R>(
  stepRoleInfo: StepRoleInfo,
  stepPath: string,
  processPath: string,
  canPass: (resource: AuthStep) => Effect.Effect<boolean, E, R>,
): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)

    if (rolePathsToTry.length === 0) {
      return yield* canPass(
        new AuthStep({
          stepPath,
          rolePath: null,
          processPath,
          startsProcess: stepRoleInfo.startsProcess,
          embedded: stepRoleInfo.embedded,
        }),
      )
    }

    for (const rolePath of rolePathsToTry) {
      const canPassRole = yield* canPass(
        new AuthStep({
          stepPath,
          rolePath,
          processPath,
          startsProcess: stepRoleInfo.startsProcess,
          embedded: stepRoleInfo.embedded,
        }),
      )
      if (canPassRole) return true
    }

    return false
  })

type StartableProcessRow = Pick<ProcessListRow, "path" | "startStepPath">

/**
 * Apply the Process catalog Cedar decision shared by RxDB pull and the public
 * list query. A Process is visible when its start step can be completed.
 */
export const filterAuthorizedProcessRows = <TRow extends StartableProcessRow>(
  context: UserContext,
  rows: readonly TRow[],
) =>
  Effect.gen(function* () {
    const principal = yield* buildStepPrincipal(context)
    return yield* filterProcessRowsForPrincipal(principal, rows)
  })

export const filterProcessRowsForPrincipal = <TRow extends StartableProcessRow>(
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
  rows: readonly TRow[],
) =>
  Effect.gen(function* () {
    if (rows.length === 0) return []

    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries
    const stepRolesMap = yield* stepRoleQueries.queryRolePathsByStepPaths(
      rows.map((row) => row.startStepPath),
    )
    const authorizedRows: TRow[] = []

    for (const row of rows) {
      if (!row.startStepPath) continue
      const stepRoleInfo = stepRolesMap.get(row.startStepPath) ?? {
        rolePath: null,
        supportingRolePaths: [],
        startsProcess: true,
        embedded: false,
      }
      const canStart = yield* trySequentialStepAuthorization(
        stepRoleInfo,
        row.startStepPath,
        row.path,
        (resource) => auth.canCompleteStep(principal, resource),
      )
      if (canStart) authorizedRows.push(row)
    }

    return authorizedRows
  })

/**
 * Apply the Todo-list Cedar decision shared by RxDB pull and the public list
 * query. Correction Required work uses its distinct correction action.
 */
export const filterAuthorizedTodoRows = (
  context: UserContext,
  rows: readonly TodoRow[],
) =>
  Effect.gen(function* () {
    const stepRoleQueries = yield* StepRoleQueries
    const stepRolesMap = yield* stepRoleQueries.queryRolePathsByStepPaths(
      rows.map((row) => row.stepPath),
    )
    const authorizedRows: TodoRow[] = []

    for (const row of rows) {
      const stepRoleInfo = stepRolesMap.get(row.stepPath)
      if (
        row.status === "Correction Required" &&
        !isProviderUserSession(context.jwt?.properties)
      ) {
        continue
      }

      const authorization =
        row.status === "Correction Required"
          ? checkPublicCompletionCorrectionAuthorization(
              context,
              row,
              stepRoleInfo,
            )
          : checkTodoAuthorization(context, row, stepRoleInfo)
      const authorized = yield* authorization.pipe(
        Effect.as(true),
        Effect.catchTag("NotAuthorized", () => Effect.succeed(false)),
      )
      if (authorized) authorizedRows.push(row)
    }

    return authorizedRows
  })

/**
 * Check if the user is authorized to access a list.
 * Uses Cedar policy: principal.roles.containsAny(resource.roles)
 */
export const checkListAuthorization = (
  context: UserContext,
  listPath: string,
  rolePaths: NonEmptyReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService

    const principal = yield* buildPrincipal(context)

    const resource = new ListRef(listPath, rolePaths)

    const canAccess = yield* auth.canAccessList(principal, resource)

    if (!canAccess) {
      yield* Effect.logWarning("Authorization denied for list access").pipe(
        Effect.annotateLogs({
          principal,
          requiredRoles: rolePaths,
          listPath,
        }),
      )

      return yield* new NotAuthorized({
        action: "query",
        resource: listPath,
        message: `User ${principal.uid.id} is not authorized to access list ${listPath}`,
      })
    }
  })

export const checkListCreateAuthorization = (
  context: UserContext,
  listPath: string,
  rolePaths: NonEmptyReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService

    const principal = yield* buildPrincipal(context)

    const resource = new ListRef(listPath, rolePaths)

    // Check authorization
    const canCreate = yield* auth.canCreateList(principal, resource)

    if (!canCreate) {
      yield* Effect.logWarning("Authorization denied for list create").pipe(
        Effect.annotateLogs({
          principal,
          requiredRoles: rolePaths,
          listPath,
        }),
      )

      return yield* new NotAuthorized({
        action: "create",
        resource: listPath,
        message: `User ${principal.uid.id} is not authorized to create list ${listPath}`,
      })
    }
  })

export const checkListUpdateAuthorization = (
  context: UserContext,
  listPath: string,
  rolePaths: NonEmptyReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService

    const principal = yield* buildPrincipal(context)

    const resource = new ListRef(listPath, rolePaths)

    // Check authorization
    const canUpdate = yield* auth.canUpdateList(principal, resource)

    if (!canUpdate) {
      yield* Effect.logWarning("Authorization denied for list update").pipe(
        Effect.annotateLogs({
          principal,
          requiredRoles: rolePaths,
          listPath,
        }),
      )

      return yield* new NotAuthorized({
        action: "update",
        resource: listPath,
        message: `User ${principal.uid.id} is not authorized to update list ${listPath}`,
      })
    }
  })

/**
 * Check if the user is authorized to delete a list item.
 * Uses Cedar policy: principal.roles.containsAny(resource.roles)
 */
export const checkListDeleteAuthorization = (
  context: UserContext,
  listPath: string,
  rolePaths: NonEmptyReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService

    const principal = yield* buildPrincipal(context)

    const resource = new ListRef(listPath, rolePaths)

    // Check authorization
    const canDelete = yield* auth.canDeleteList(principal, resource)

    if (!canDelete) {
      yield* Effect.logWarning("Authorization denied for list delete").pipe(
        Effect.annotateLogs({
          principal,
          requiredRoles: rolePaths,
          listPath,
        }),
      )

      return yield* new NotAuthorized({
        action: "delete",
        resource: listPath,
        message: `User ${principal.uid.id} is not authorized to delete from list ${listPath}`,
      })
    }
  })

export {
  canPrincipalSkipScheduleWaits,
  tryPublicCompletionCorrectionAuthorization,
}

type Tail<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : never
export const buildPrincipal = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_buildPrincipal>>
) => execution_buildPrincipal(executionIdentity(context), ...args)
export const buildStepPrincipal = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_buildStepPrincipal>>
) => execution_buildStepPrincipal(executionIdentity(context), ...args)
export const checkStepAuthorization = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_checkStepAuthorization>>
) => execution_checkStepAuthorization(executionIdentity(context), ...args)
export const checkTodoAuthorization = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_checkTodoAuthorization>>
) => execution_checkTodoAuthorization(executionIdentity(context), ...args)
export const checkPublicCompletionCorrectionAuthorization = (
  context: UserContext,
  ...args: Tail<
    Parameters<typeof execution_checkPublicCompletionCorrectionAuthorization>
  >
) =>
  execution_checkPublicCompletionCorrectionAuthorization(
    executionIdentity(context),
    ...args,
  )
export const canModifyField = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_canModifyField>>
) => execution_canModifyField(executionIdentity(context), ...args)
export const canSkipScheduleWaits = (
  context: UserContext,
  ...args: Tail<Parameters<typeof execution_canSkipScheduleWaits>>
) => execution_canSkipScheduleWaits(executionIdentity(context), ...args)
