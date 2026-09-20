import { Effect, Option } from "effect"
import {
  Execution as AuthExecution,
  Step as AuthStep,
  type AuthorizationError,
  AuthorizationService,
  DelegationPrincipal,
  FormField,
  ListRef,
  type NonEmptyReadonlyArray,
  ProcessRef,
  ProviderUserPrincipal,
  PublicLinkPrincipal,
  ServiceAccountPrincipal,
  TodoRef,
} from "@pf/auth-policy"
import {
  type ProcessListRow,
  type StepRoleInfo,
  StepRoleQueries,
  type TodoRow,
  type TodoWithStepInfo,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import { NoProviderUserID, NotAuthorized } from "@pf/graphql-schema"
import { OrganisationProvider, normalizePath } from "@pf/process"
import type { RequestTime } from "@pf/request-time"
import { getProcessPathFromStepPath } from "./resolver-utils"
import type { AssembledExecution } from "./rxdb/execution"
import {
  hasDelegation,
  isProviderUserSession,
  isServiceAccountSession,
} from "./session-guards"
import type { UserContext } from "./types"

/**
 * Preserve the accepted provider-user or delegation actor from request context.
 */
export const buildPrincipal = (
  context: UserContext,
): Effect.Effect<
  ProviderUserPrincipal | DelegationPrincipal,
  NoProviderUserID
> =>
  Effect.gen(function* () {
    const props = context.jwt?.properties
    if (hasDelegation(props)) {
      if (!isProviderUserSession(props) || !props.delegation) {
        return yield* new NoProviderUserID({
          message: "Delegation principal validation is required",
        })
      }
      return new DelegationPrincipal(props.delegation.id, {
        owner: props.email,
        name: props.delegation.name,
        roles: props.roles,
        orgUnitId: props.orgUnitPath,
      })
    }
    // Cedar ProviderUser entity ids are stable login emails. Invitations and
    // custom Cedar policies know emails, not generated database provider_user.id.
    const userId = isProviderUserSession(props) ? props.email : context.userId
    const roles: readonly string[] = props?.roles ?? []
    // Use orgUnitPath for Cedar entity id (path-based matching in policies)
    // Only provider users have orgUnitPath/orgUnitId
    const orgUnitPath = isProviderUserSession(props)
      ? (props.orgUnitPath ?? props.orgUnitId ?? "")
      : ""

    if (!userId) {
      yield* Effect.logError("User ID not found in context").pipe(
        Effect.annotateLogs({
          hasJwt: context.jwt !== undefined,
          hasProperties: props !== undefined,
          isProviderUserSession: isProviderUserSession(props),
          contextUserId: context.userId,
          propsUserId: isProviderUserSession(props) ? props.userId : undefined,
          propsEmail: isProviderUserSession(props) ? props.email : undefined,
        }),
      )
      return yield* new NoProviderUserID({
        message: "User ID not found in context",
      })
    }

    // Build principal from context
    // Note: ProviderUserPrincipal.orgUnitId parameter is used as the Cedar entity id,
    // which should be the path for policy matching
    const principal = new ProviderUserPrincipal(userId, {
      roles,
      orgUnitId: orgUnitPath,
    })
    return principal
  })

/**
 * Build the actual caller for step checks, process capabilities and execution
 * presentation. Service-account sessions stay service accounts so Cedar must
 * explicitly permit their actions.
 */
export const buildStepPrincipal = (
  context: UserContext,
): Effect.Effect<
  ProviderUserPrincipal | DelegationPrincipal | ServiceAccountPrincipal,
  NoProviderUserID
> =>
  Effect.gen(function* () {
    const props = context.jwt?.properties

    if (isServiceAccountSession(props)) {
      return new ServiceAccountPrincipal(
        props.clientId,
        props.roles ?? [], // roles are optional on M2M tokens
      )
    }

    return yield* buildPrincipal(context)
  })

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
export const checkStepAuthorization = (
  context: UserContext,
  stepPath: string,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries

    const stepRoleInfo =
      yield* stepRoleQueries.queryRolePathsByStepPath(stepPath)
    const processPath = getProcessPathFromStepPath(stepPath)
    const principal = yield* buildStepPrincipal(context)

    const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)

    if (rolePathsToTry.length === 0) {
      const resource = new AuthStep({
        stepPath,
        rolePath: null,
        processPath,
        startsProcess: stepRoleInfo.startsProcess,
        embedded: stepRoleInfo.embedded,
      })
      const canComplete = yield* auth.canCompleteStep(principal, resource)
      if (!canComplete) {
        const action = stepRoleInfo.startsProcess ? "start" : "complete"
        return yield* new NotAuthorized({
          action,
          resource: stepPath,
          message: `User ${principal.uid.id} is not authorized to ${action} step ${stepPath}`,
        })
      }
      return null
    }

    for (const rolePath of rolePathsToTry) {
      const resource = new AuthStep({
        stepPath,
        rolePath,
        processPath,
        startsProcess: stepRoleInfo.startsProcess,
        embedded: stepRoleInfo.embedded,
      })
      const canComplete = yield* auth.canCompleteStep(principal, resource)
      if (canComplete) {
        return rolePath
      }
    }

    // None passed
    const action = stepRoleInfo.startsProcess ? "start" : "complete"
    yield* Effect.logWarning(`Authorization denied for ${action} step`).pipe(
      Effect.annotateLogs({
        principal,
        primaryRole: stepRoleInfo.rolePath,
        supportingRoles: stepRoleInfo.supportingRolePaths,
        stepPath,
        startsProcess: stepRoleInfo.startsProcess,
      }),
    )

    return yield* new NotAuthorized({
      action,
      resource: stepPath,
      message: `User ${principal.uid.id} is not authorized to ${action} step ${stepPath}`,
    })
  })

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
    if (rows.length === 0) return []

    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries
    const principal = yield* buildStepPrincipal(context)
    const stepRolesMap = yield* stepRoleQueries.queryRolePathsByStepPaths(
      rows.map((row) => row.startStepPath),
    )
    const authorizedRows: TRow[] = []

    for (const row of rows) {
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

type TodoAuthorizationInfo = Pick<
  TodoRow,
  | "id"
  | "stepPath"
  | "processPath"
  | "processOrgUnitPath"
  | "assignedToProviderUserEmail"
>

type TodoCompletionInfo = Pick<
  TodoWithStepInfo,
  | "id"
  | "targetStepPath"
  | "processPath"
  | "orgUnitPath"
  | "assignedToProviderUserEmail"
>

const isExecutionFailureNotifications = (
  construct: unknown,
): construct is {
  readonly isExecutionFailureNotifications: true
  readonly roles: ReadonlyArray<{ readonly node: { readonly path: string } }>
} =>
  typeof construct === "object" &&
  construct !== null &&
  "isExecutionFailureNotifications" in construct &&
  construct.isExecutionFailureNotifications === true &&
  "roles" in construct &&
  Array.isArray(construct.roles)

const resolveExecutionFailureRolePaths = () =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    if (Option.isNone(organisationProvider)) return []

    let construct: unknown
    try {
      construct = organisationProvider.value.organisation.node.findChild(
        "ExecutionFailureNotifications",
      )
    } catch (error) {
      // The notification construct is optional; findChild throws when absent.
      yield* Effect.logDebug("ExecutionFailureNotifications lookup skipped", {
        error: String(error),
      })
      return []
    }

    if (!isExecutionFailureNotifications(construct)) return []
    return construct.roles.map((role) => normalizePath(role.node.path))
  })

const todoStepPath = (todo: TodoAuthorizationInfo | TodoCompletionInfo) =>
  "stepPath" in todo ? todo.stepPath : todo.targetStepPath

const todoOrgUnitPath = (todo: TodoAuthorizationInfo | TodoCompletionInfo) =>
  "processOrgUnitPath" in todo ? todo.processOrgUnitPath : todo.orgUnitPath

const todoRef = (
  todo: TodoAuthorizationInfo | TodoCompletionInfo,
  rolePath: string | null,
  assignedToProviderUserEmail: string | null | undefined,
) =>
  new TodoRef(todo.id, {
    stepPath: todoStepPath(todo),
    rolePath,
    processPath: todo.processPath,
    orgUnitId: todoOrgUnitPath(todo),
    assignedToProviderUserEmail,
  })

export const tryPublicCompletionCorrectionAuthorization = (
  principal: ProviderUserPrincipal,
  todo: TodoAuthorizationInfo,
  prefetchedStepRoleInfo?: StepRoleInfo,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries
    const stepRoleInfo =
      prefetchedStepRoleInfo ??
      (yield* stepRoleQueries.queryRolePathsByStepPath(todo.stepPath))
    const responsibleRolePaths = collectRolePathsToTry(stepRoleInfo)
    const failureRolePaths = yield* resolveExecutionFailureRolePaths()

    for (const rolePath of responsibleRolePaths) {
      // Responsible-role checks preserve direct-assignee narrowing in Cedar.
      const canCorrect = yield* auth.canCorrectPublicCompletionTodo(
        principal,
        todoRef(todo, rolePath, todo.assignedToProviderUserEmail),
      )
      if (canCorrect) return { authorized: true, rolePath } as const
    }

    for (const rolePath of failureRolePaths) {
      // Failure-notification roles are oversight responders and intentionally
      // bypass direct-assignee narrowing for correction-required Todos.
      const canCorrect = yield* auth.canCorrectPublicCompletionTodo(
        principal,
        todoRef(todo, rolePath, null),
      )
      if (canCorrect) return { authorized: true, rolePath } as const
    }

    return { authorized: false } as const
  })

export const checkPublicCompletionCorrectionAuthorization = (
  context: UserContext,
  todo: TodoAuthorizationInfo,
  prefetchedStepRoleInfo?: StepRoleInfo,
) =>
  Effect.gen(function* () {
    const principal = yield* buildPrincipal(context)
    const result = yield* tryPublicCompletionCorrectionAuthorization(
      principal,
      todo,
      prefetchedStepRoleInfo,
    )

    if (result.authorized) return result.rolePath

    return yield* new NotAuthorized({
      action: "publicCompletionCorrection",
      resource: todo.id,
      message: `User ${principal.uid.id} is not authorized to correct public completion todo ${todo.id}`,
    })
  })

export const checkTodoAuthorization = (
  context: UserContext,
  todo: TodoAuthorizationInfo | TodoCompletionInfo,
  prefetchedStepRoleInfo?: StepRoleInfo,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries
    const principal = yield* buildStepPrincipal(context)
    const stepPath = todoStepPath(todo)
    const stepRoleInfo =
      prefetchedStepRoleInfo ??
      (yield* stepRoleQueries.queryRolePathsByStepPath(stepPath))
    const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)

    if (rolePathsToTry.length === 0) {
      // Role-less todos can still be allowed by direct assignment policies.
      const canComplete = yield* auth.canCompleteTodo(
        principal,
        todoRef(todo, null, todo.assignedToProviderUserEmail),
      )
      if (canComplete) return null
    }

    for (const rolePath of rolePathsToTry) {
      const canComplete = yield* auth.canCompleteTodo(
        principal,
        todoRef(todo, rolePath, todo.assignedToProviderUserEmail),
      )
      if (canComplete) return rolePath
    }

    return yield* new NotAuthorized({
      action: "complete",
      resource: todo.id,
      message: `User ${principal.uid.id} is not authorized to complete todo ${todo.id}`,
    })
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

export const canModifyField = (
  context: UserContext,
  props: {
    readonly stepPath: string
    readonly fieldName: string
    readonly rolePath?: string | null | undefined
    readonly stepRolePath?: string | null | undefined
    readonly processPath: string
    readonly orgUnitId?: string
    readonly stepStartsProcess?: boolean
    readonly stepEmbedded?: boolean
  },
) =>
  Effect.gen(function* () {
    if (!isProviderUserSession(context.jwt?.properties)) {
      return false
    }

    const auth = yield* AuthorizationService
    const principal = yield* buildPrincipal(context)
    return yield* auth.canModifyField(principal, new FormField(props))
  })

export const checkPublicTodoAuthorization = (todoId: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    // The token binds a public link to exactly one todo, so this permits by
    // construction today. Cedar becomes meaningful once public-link entities
    // carry independent link IDs or revocation/scoping attributes.
    const principal = new PublicLinkPrincipal(todoId)
    const resource = new TodoRef(todoId)
    const canComplete = yield* auth.canCompletePublicTodo(principal, resource)

    if (!canComplete) {
      yield* Effect.logWarning("Authorization denied for public todo", {
        todoId,
      })
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message: "This public link is not authorized to complete this todo",
      })
    }
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

    // Check authorization
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

/**
 * Check if the user is authorized to update a list item.
 * Uses Cedar policy: principal.roles.containsAny(resource.roles)
 */
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

/** Shared process permission for start requests, pull queries and stream delivery. */
export const canPrincipalSkipScheduleWaits = (
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
  processPath: string,
): Effect.Effect<
  boolean,
  AuthorizationError,
  AuthorizationService | RequestTime
> =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    return yield* auth.canPerformAction(
      principal,
      new ProcessRef(processPath),
      {
        type: "PF::Action",
        id: "skipScheduleWaits",
      },
    )
  })

/** Additional, process-targeted permission; ordinary start permission is separate. */
export const canSkipScheduleWaits = (
  context: UserContext,
  processPath: string,
) =>
  Effect.gen(function* () {
    const principal = yield* buildStepPrincipal(context)
    return yield* canPrincipalSkipScheduleWaits(principal, processPath)
  })

export const checkScheduleModeAuthorization = (
  context: UserContext,
  processPath: string,
  withoutWaiting: boolean,
) =>
  Effect.gen(function* () {
    if (
      withoutWaiting &&
      !(yield* canSkipScheduleWaits(context, processPath))
    ) {
      return yield* new NotAuthorized({
        action: "skipScheduleWaits",
        resource: processPath,
        message: "Not authorized to skip scheduled waits for this process",
      })
    }
  })
