import { Effect, Option } from "effect"
import {
  Step as AuthStep,
  AuthorizationService,
  type ServiceAccountPrincipalType,
  type UserPrincipal,
} from "@pf/auth-policy"
import {
  ExecutionQueries,
  ScheduledFlowOperations,
  StepCompletionOperations,
  StepRoleQueries,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import { getProcessPathFromStepPath } from "./resolver-utils"

export const isAbandonableExecutionStatus = (status: string): boolean =>
  status === "Running" || status === "Failed"

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

    const auth = yield* AuthorizationService
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
        const canAbandon = yield* auth
          .canAbandonStep(principal, resource)
          .pipe(Effect.orElseSucceed(() => false))
        if (canAbandon) {
          return { authorized: true, hasAbandonableSteps: true }
        }
      }
    }

    return { authorized: false, hasAbandonableSteps: true }
  })
