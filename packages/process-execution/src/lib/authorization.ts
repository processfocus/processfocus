import { Effect, Option } from "effect"
import {
  Step as AuthStep,
  type AuthorizationError,
  AuthorizationService,
  type CronStartContext,
  DelegationPrincipal,
  FormField,
  ProcessRef,
  ProviderUserPrincipal,
  PublicLinkPrincipal,
  ServiceAccountPrincipal,
} from "@pf/auth-policy"
import {
  StepCompletionOperations,
  type StepRoleInfo,
  StepRoleQueries,
  type TodoRow,
  type TodoWithStepInfo,
  collectRolePathsToTry,
} from "@pf/graphql-db-operations"
import { NoProviderUserID, NotAuthorized } from "@pf/graphql-schema/errors"
import { OrganisationProvider, normalizePath } from "@pf/process"
import type { RequestTime } from "@pf/request-time"
import {
  type ExecutionIdentity,
  hasDelegation,
  isProviderUserSession,
  isServiceAccountSession,
} from "./identity"

const getProcessPathFromStepPath = (path: string) =>
  path.slice(0, path.lastIndexOf("/"))
export const buildPrincipal = (
  context: ExecutionIdentity,
): Effect.Effect<
  ProviderUserPrincipal | DelegationPrincipal,
  NoProviderUserID
> =>
  Effect.gen(function* () {
    const props = context.session
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
          hasJwt: context.session !== undefined,
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
  context: ExecutionIdentity,
): Effect.Effect<
  ProviderUserPrincipal | DelegationPrincipal | ServiceAccountPrincipal,
  NoProviderUserID
> =>
  Effect.gen(function* () {
    const props = context.session

    if (isServiceAccountSession(props)) {
      return new ServiceAccountPrincipal(
        props.clientId,
        props.roles ?? [], // roles are optional on M2M tokens
      )
    }

    return yield* buildPrincipal(context)
  })

export const checkStepAuthorization = (
  context: ExecutionIdentity,
  stepPath: string,
  operation: "complete" | "viewEmbeddedForm" = "complete",
  cronStart?: CronStartContext,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const stepRoleQueries = yield* StepRoleQueries

    const stepRoleInfo =
      yield* stepRoleQueries.queryRolePathsByStepPath(stepPath)
    const processPath = getProcessPathFromStepPath(stepPath)
    const principal = yield* buildStepPrincipal(context)

    const authorize =
      operation === "viewEmbeddedForm"
        ? auth.canViewEmbeddedForm
        : (actor: typeof principal, step: AuthStep) =>
            auth.canCompleteStep(actor, step, cronStart)

    const rolePathsToTry = collectRolePathsToTry(stepRoleInfo)

    if (rolePathsToTry.length === 0) {
      const resource = new AuthStep({
        stepPath,
        rolePath: null,
        processPath,
        startsProcess: stepRoleInfo.startsProcess,
        embedded: stepRoleInfo.embedded,
      })
      const canComplete = yield* authorize(principal, resource)
      if (!canComplete) {
        const action =
          operation === "viewEmbeddedForm"
            ? operation
            : stepRoleInfo.startsProcess
              ? "start"
              : "complete"
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
      const canComplete = yield* authorize(principal, resource)
      if (canComplete) {
        return rolePath
      }
    }

    // None passed
    const action =
      operation === "viewEmbeddedForm"
        ? operation
        : stepRoleInfo.startsProcess
          ? "start"
          : "complete"
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

const todoStep = (
  todo: TodoAuthorizationInfo | TodoCompletionInfo,
  rolePath: string | null,
  stepRoleInfo: StepRoleInfo,
) =>
  new AuthStep({
    stepPath: todoStepPath(todo),
    rolePath,
    processPath: todo.processPath,
    orgUnitId: todoOrgUnitPath(todo) ?? "",
    startsProcess: stepRoleInfo.startsProcess,
    embedded: stepRoleInfo.embedded,
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
        todoStep(todo, rolePath, stepRoleInfo),
        {
          todoId: todo.id,
          assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
        },
      )
      if (canCorrect) return { authorized: true, rolePath } as const
    }

    for (const rolePath of failureRolePaths) {
      // Failure-notification roles are oversight responders and intentionally
      // bypass direct-assignee narrowing for correction-required Todos.
      const canCorrect = yield* auth.canCorrectPublicCompletionTodo(
        principal,
        todoStep(todo, rolePath, stepRoleInfo),
        { todoId: todo.id },
      )
      if (canCorrect) return { authorized: true, rolePath } as const
    }

    return { authorized: false } as const
  })

export const checkPublicCompletionCorrectionAuthorization = (
  context: ExecutionIdentity,
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
  context: ExecutionIdentity,
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
      const canComplete = yield* auth.canCompleteStep(
        principal,
        todoStep(todo, null, stepRoleInfo),
        {
          todoId: todo.id,
          assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
        },
      )
      if (canComplete) return null
    }

    for (const rolePath of rolePathsToTry) {
      const canComplete = yield* auth.canCompleteStep(
        principal,
        todoStep(todo, rolePath, stepRoleInfo),
        {
          todoId: todo.id,
          assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
        },
      )
      if (canComplete) return rolePath
    }

    return yield* new NotAuthorized({
      action: "complete",
      resource: todo.id,
      message: `User ${principal.uid.id} is not authorized to complete todo ${todo.id}`,
    })
  })

export const canModifyField = (
  context: ExecutionIdentity,
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
    if (!isProviderUserSession(context.session)) {
      return false
    }

    const auth = yield* AuthorizationService
    const principal = yield* buildPrincipal(context)
    return yield* auth.canModifyField(principal, new FormField(props))
  })

export const checkPublicTodoAuthorization = (
  capabilityTodoId: string,
  todoId: string,
) =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const operations = yield* StepCompletionOperations
    const todo = yield* operations.queryTodoForCompletionById(todoId)
    if (!todo)
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message: "This public link has no available step",
      })
    const stepRoleQueries = yield* StepRoleQueries
    const info = yield* stepRoleQueries.queryRolePathsByStepPath(
      todo.targetStepPath,
    )
    const principal = new PublicLinkPrincipal(capabilityTodoId)
    const resource = todoStep(todo, info.rolePath, info)
    const canComplete = yield* auth.canCompleteStep(principal, resource, {
      todoId,
      assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
    })

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
  context: ExecutionIdentity,
  processPath: string,
) =>
  Effect.gen(function* () {
    const principal = yield* buildStepPrincipal(context)
    return yield* canPrincipalSkipScheduleWaits(principal, processPath)
  })

export const checkScheduleModeAuthorization = (
  context: ExecutionIdentity,
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
