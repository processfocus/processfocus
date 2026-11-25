import { Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import {
  Step as AuthStep,
  AuthorizationService,
  type ServiceAccountPrincipalType,
  type UserPrincipal,
} from "@pf/auth-policy"
import {
  ExecutionQueries,
  type ExecutionRow,
  ScheduledFlowOperations,
  StepCompletionOperations,
  type StepRoleInfo,
  StepRoleQueries,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import type { RequestTime } from "@pf/request-time"

const getProcessPathFromStepPath = (path: string): string =>
  path.slice(0, path.lastIndexOf("/"))

export const isAbandonableExecutionStatus = (status: string): boolean =>
  status === "Running" || status === "Failed"

const authorizeAbandonStepPaths = (
  principal: UserPrincipal | ServiceAccountPrincipalType,
  stepPaths: readonly string[],
  stepRoleMap: ReadonlyMap<string, StepRoleInfo>,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    for (const stepPath of stepPaths) {
      const stepRoleInfo = stepRoleMap.get(stepPath) ?? {
        rolePath: null,
        supportingRolePaths: [],
        startsProcess: false,
        embedded: false,
      }
      const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)
      const candidateRolePaths =
        rolePathsToTry.length > 0 ? rolePathsToTry : [null]
      for (const rolePath of candidateRolePaths) {
        const resource = new AuthStep({
          stepPath,
          rolePath,
          processPath: getProcessPathFromStepPath(stepPath),
          startsProcess: stepRoleInfo.startsProcess,
          embedded: stepRoleInfo.embedded,
        })
        const authorized = yield* auth
          .canAbandonStep(principal, resource)
          .pipe(Effect.orElseSucceed(() => false))
        if (authorized) return { authorized: true, hasAbandonableSteps: true }
      }
    }
    return { authorized: false, hasAbandonableSteps: stepPaths.length > 0 }
  })

/** Page-scoped reads: don't repeat five remote SQL calls for every execution. */
export const checkExecutionAbandonAuthorizations = (
  principal: UserPrincipal | ServiceAccountPrincipalType,
  executions: readonly Pick<ExecutionRow, "id" | "status" | "startStepPath">[],
): Effect.Effect<
  ReadonlyMap<string, boolean>,
  SqlError,
  ExecutionQueries | StepRoleQueries | AuthorizationService | RequestTime
> =>
  Effect.gen(function* () {
    const candidates = executions.filter((execution) =>
      isAbandonableExecutionStatus(execution.status),
    )
    const authorized = new Map<string, boolean>()
    if (candidates.length === 0) return authorized
    const queries = yield* ExecutionQueries
    const roles = yield* StepRoleQueries
    const work = yield* queries.getUnfinishedWorkForExecutions(
      candidates.map((execution) => execution.id),
    )
    const pathsByExecution = candidates.map((execution) => {
      const todos = work.todos.filter(
        (todo) => todo.executionId === execution.id,
      )
      const active = todos
        .filter((todo) => todo.failureReason === null)
        .map((todo) => todo.stepPath)
      const scheduled = work.scheduledFlows
        .filter((flow) => flow.executionId === execution.id)
        .map((flow) => flow.targetStepPath ?? flow.sourceStepPath)
      const failed = todos
        .filter((todo) => todo.failureReason !== null)
        .map((todo) => todo.stepPath)
      // Same precedence as the mutation's single-execution check. Never grant
      // start-step fallback authority over an active Todo or pending flow.
      const paths =
        active.length > 0
          ? active
          : scheduled.length > 0
            ? scheduled
            : failed.length > 0
              ? failed
              : [execution.startStepPath]
      return { id: execution.id, paths: [...new Set(paths)] }
    })
    const stepRoles = yield* roles.queryRolePathsByStepPaths([
      ...new Set(pathsByExecution.flatMap((execution) => execution.paths)),
    ])
    for (const execution of pathsByExecution) {
      const decision = yield* authorizeAbandonStepPaths(
        principal,
        execution.paths,
        stepRoles,
      )
      authorized.set(execution.id, decision.authorized)
    }
    return authorized
  })

const queryFallbackAbandonStepPaths = (
  executionId: string,
  startStepPath: string | undefined,
) =>
  Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations
    const failedTodos =
      yield* stepCompletionOps.queryFailedTodosForExecution(executionId)
    const failedStepPaths = failedTodos.map((todo) => todo.stepPath)
    if (failedStepPaths.length > 0) {
      return failedStepPaths
    }
    if (startStepPath !== undefined) {
      return [startStepPath]
    }

    const executionQueries = yield* Effect.serviceOption(ExecutionQueries)
    return yield* Option.match(executionQueries, {
      onNone: () => Effect.succeed([] as string[]),
      onSome: (queries) =>
        queries.getExecutions([executionId]).pipe(
          Effect.map((executions) => {
            const path = executions[0]?.startStepPath
            return path === undefined ? [] : [path]
          }),
        ),
    })
  })

export const checkExecutionAbandonAuthorization = (
  principal: UserPrincipal | ServiceAccountPrincipalType,
  executionId: string,
  status: string,
  options?: { readonly startStepPath?: string },
) =>
  Effect.gen(function* () {
    if (!isAbandonableExecutionStatus(status)) {
      return { authorized: false, hasAbandonableSteps: false }
    }

    const stepCompletionOps = yield* StepCompletionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const stepRoleQueries = yield* StepRoleQueries

    const activeStepPaths =
      yield* stepCompletionOps.queryActiveTodoStepPaths(executionId)
    const pendingOrActiveStepPaths =
      activeStepPaths.length > 0
        ? activeStepPaths
        : yield* scheduledFlowOps.queryPendingAbandonStepPaths(executionId)
    // No live Todo or scheduled flow: authorize against failed Todos or the
    // start step. Covers Docker-failed rows still marked Running and in-flight
    // roleless system-starts, not only Failed executions.
    const stepPaths =
      pendingOrActiveStepPaths.length > 0
        ? pendingOrActiveStepPaths
        : yield* queryFallbackAbandonStepPaths(
            executionId,
            options?.startStepPath,
          )

    if (stepPaths.length === 0) {
      return { authorized: false, hasAbandonableSteps: false }
    }

    const stepRoleMap =
      yield* stepRoleQueries.queryRolePathsByStepPaths(stepPaths)

    return yield* authorizeAbandonStepPaths(principal, stepPaths, stepRoleMap)
  })
