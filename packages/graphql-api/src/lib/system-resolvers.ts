import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type DocumentStoreError,
  DocumentStoreService,
  EmailSender,
  FileNotFoundError,
  NotificationDeliveryConfig,
} from "@processfocus/runtime"
import {
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import type { GraphQLResolveInfo } from "graphql"
import { prepareRoleSwitch, providerUserAuthorityVersion } from "@pf/auth-api"
import { LocalCedarConfig, PolicyWatcherService } from "@pf/auth-local-cedar"
import {
  Application,
  AuthorizationService,
  DelegationPrincipal,
  FileRef,
  GraphQLField,
  ListRef,
  ProviderUserPrincipal,
  RoleRef,
  ServiceAccountPrincipal,
} from "@pf/auth-policy"
import { immediateTransactionRequested, isSqlLockError } from "@pf/db-info"
import {
  type CalendarSlotFieldMetadata,
  Email,
  FormCalendarSlotInput,
  FormLookupInput,
  FormPermission,
  FormProviderUserInput,
  FormRequestData,
  type LookupFieldMetadata,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
import {
  CleanupOperations,
  ExecutionQueries,
  FileOperations,
  InvitationLifecycleStatus,
  InvitationSource,
  OAuthClientQueries,
  OrgQueries,
  type OrgUnitRow,
  ProcessQueries,
  ProviderUserQueries,
  type ProviderUserRow,
  RegistrationLinkStatus,
  type RoleRow,
  ScheduledFlowOperations,
  type SettingsInvitationRow,
  SettingsQueries,
  type SettingsRoleRow,
  StepCompletionOperations,
  StepRoleQueries,
  TodoQueries,
  WorkflowQueries,
} from "@pf/graphql-db-operations"
import type { ResolversParentTypes, ResolversTypes } from "@pf/graphql-schema"
import {
  DocumentStoreNotFoundError,
  InputValidationError,
  NoProviderUserID,
  NotAuthorized,
  ProcessStateNotFound,
  ProviderUserNotFound,
  PublicCompletionInvitationNotFound,
} from "@pf/graphql-schema"
import {
  IMMUTABLE_INVITATION_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  NO_ACTIVE_REGISTRATION_LINK_MESSAGE,
  REGISTRATION_LINK_CONFLICT_MESSAGE,
  TRUSTED_FRONTEND_ORIGIN_NOT_CONFIGURED_MESSAGE,
  issueRegistrationLink,
  mapRegistrationLinkCryptoError,
} from "@pf/identity-management"
import {
  buildRegistrationLinkUrl,
  decryptRegistrationLinkToken,
} from "@pf/identity-management/credentials"
import {
  type FlowContext,
  type Form,
  type List,
  LookupFieldNotFoundError,
  OrganisationProvider,
  type StatsView,
  type StepMeta,
  buildFlowContext,
  countLeafFields,
  normalizePath,
  pathToPascalCase,
  resolveFormFieldDefaults,
} from "@pf/process"
import {
  abandonExecution,
  completeTodoFromChat,
  correctPublicCompletion,
  inspectPublicCompletion,
  inspectTodoForm,
  renewPublicCompletionInvitation,
  restartExecution,
  submitPublicCompletion,
} from "@pf/process-execution"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  buildPublicTodoUrl,
  decryptPublicTodoToken,
  encryptPublicTodoToken,
} from "@pf/public-completion/credentials"
import { TodoSummaryComputation } from "@pf/todo-summary"
import { actorDisplayLabel } from "./actor-presentation"
import {
  anonymousPage,
  anonymousPageLookup,
  submitAnonymousPage,
} from "./anonymous-page"
import {
  buildPrincipal,
  buildStepPrincipal,
  canModifyField,
  canSkipScheduleWaits,
  checkListAuthorization,
  checkListCreateAuthorization,
  checkListUpdateAuthorization,
  checkPublicCompletionCorrectionAuthorization,
  checkStepAuthorization,
  checkTodoAuthorization,
  filterAuthorizedExecutionRows,
  filterAuthorizedProcessRows,
  filterAuthorizedTodoRows,
} from "./authorization"
import {
  clampPaginationWindow,
  createPaginatedCollectionResolver,
  queryAuthorizedPage,
} from "./collection-resolvers"
import { requestDatabaseUploadUrl } from "./database-transfer"
import { resolveDeploymentProbe } from "./deployment-probe"
import { executionIdentity } from "./execution-adapter"
import { parseExecutionListStatus } from "./execution-list-filters"
import { ListExportService } from "./list-export"
import {
  canModifyListFieldForAnyRole,
  rolePathsForList,
} from "./list-field-authorization"
import { listMetadata } from "./list-metadata"
import { validateProcessListStatus } from "./process-list-filters"
import { projectProcessStartForm } from "./process-start-form"
import { getSchemaAnnotationDeep, getSubmissionFields } from "./resolver-utils"
import { ExecutionCollectionOps } from "./rxdb/execution"
import { filterAuthorizedExecutions } from "./rxdb/subscription-filters"
import {
  hasDelegation,
  isProviderUserSession,
  isServiceAccountSession,
  rejectUnsupportedDelegationHandoff,
} from "./session-guards"
import { startFormContext } from "./start-form-context"
import { parseTodoListStatusPredicate } from "./todo-list-filters"
import type { ResolverMap, UserContext } from "./types"
import { calculateStepColumns } from "./workflow-columns"

const SQLITE_BUSY_RETRY_SCHEDULE = Schedule.addDelay(Schedule.recurs(4), () =>
  Effect.succeed(Duration.millis(100)),
)
const SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE = Schedule.max([
  Schedule.exponential("100 millis", 2),
  Schedule.recurs(3),
])
const isSqliteBusy = (error: unknown): boolean => {
  let current: unknown = error

  while (current != null) {
    if (current instanceof Error) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current = current.cause
      continue
    }

    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current = "cause" in current ? current.cause : undefined
      continue
    }

    if (
      typeof current === "string" &&
      (current.includes("SQLITE_BUSY") ||
        current.includes("database is locked") ||
        current.includes("SQL statements in progress"))
    ) {
      return true
    }

    break
  }

  return false
}

/**
 * Maps an OrgUnitRow to GraphQL OrgUnit type
 */
const mapOrgUnit = (o: OrgUnitRow): ResolversTypes["OrgUnit"] => {
  return {
    ...o,
    level: o.orgUnitLevel,
    startDayOfWeek: o.startDayOfWeek ?? 0,
    processes: [],
    roles: [],
    subunits: [],
  }
}

type InvitationMutationInput = {
  readonly email: string
  readonly roleIds: readonly string[]
}

type PublicTodoStatusGraphql =
  | "ACTIVE"
  | "COMPLETED"
  | "EXPIRED"
  | "UNAVAILABLE"

type PublicTodoResult = {
  readonly todoId: string
  readonly status: PublicTodoStatusGraphql
  readonly organisationName?: string | null
  readonly completionMessage?: string | null
  readonly formMetadata: Record<string, unknown> | null
}

const decodeTodoChatAnswers = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.JsonObject)(input).pipe(
    Effect.mapError(
      () =>
        new InputValidationError({
          errors: [{ field: "", message: "Answers must be a JSON object." }],
        }),
    ),
  )

const currentProviderUserDefault = (
  context: UserContext,
): string | undefined =>
  isProviderUserSession(context.jwt?.properties)
    ? context.jwt.properties.email
    : undefined

const buildProviderUserRoleSwitchPrincipal = (
  providerUser: {
    readonly id: string
    readonly email: string
    readonly orgUnitPath?: string | null
  },
  context: UserContext,
) =>
  Effect.gen(function* () {
    const providerUserQueries = yield* ProviderUserQueries
    const props = context.jwt?.properties
    let roleOwner = providerUser
    if (hasDelegation(props)) {
      if (!isProviderUserSession(props) || !props.delegation) {
        return yield* new NoProviderUserID({
          message: "Delegation principal validation is required",
        })
      }
      const owner = yield* providerUserQueries.queryProviderUserByUserId(
        props.userId,
      )
      if (Option.isNone(owner)) {
        return yield* new ProviderUserNotFound({
          userId: props.userId,
          message: "Delegation owner not found",
        })
      }
      roleOwner = owner.value
    }
    const rolePaths = yield* providerUserQueries.queryProviderUserRolePaths(
      roleOwner.id,
    )
    const orgUnitPath =
      roleOwner.orgUnitPath ??
      (yield* providerUserQueries
        .queryProviderUserByProviderUserId(roleOwner.id)
        .pipe(
          Effect.flatMap((providerUserOption) =>
            Option.isSome(providerUserOption)
              ? Effect.succeed(providerUserOption.value.orgUnitPath)
              : Effect.fail(
                  new ProviderUserNotFound({
                    userId: roleOwner.id,
                    message: `Provider user ${roleOwner.id} not found while resolving role switch principal`,
                  }),
                ),
          ),
        ))

    if (isProviderUserSession(props) && props.delegation) {
      return new DelegationPrincipal(props.delegation.id, {
        owner: roleOwner.email,
        name: props.delegation.name,
        roles: rolePaths,
        orgUnitId: orgUnitPath,
      })
    }

    return new ProviderUserPrincipal(roleOwner.email, {
      roles: rolePaths,
      // Cedar org-unit entity ids are path-based in GraphQL auth.
      orgUnitId: orgUnitPath,
    })
  })

const providerUserLabel = (providerUser: ProviderUserRow): string => {
  const name = providerUser.name.trim()
  return name.length > 0 ? name : providerUser.email
}

const PROVIDER_USER_LOOKUP_MAX_SCANNED = 1000

const isCurrentProviderUser = (
  providerUser: ProviderUserRow,
  currentProviderUser: Option.Option<ProviderUserRow>,
  context: UserContext,
): boolean => {
  if (!isProviderUserSession(context.jwt?.properties)) return false
  if (Option.isNone(currentProviderUser)) return false

  // Only an authenticated provider-user session can bypass actOnBehalfOf for
  // itself; other session types still go through Cedar.
  return (
    providerUser.id === currentProviderUser.value.id ||
    providerUser.userId === currentProviderUser.value.userId ||
    providerUser.email === currentProviderUser.value.email
  )
}

const providerUserLookupSuggestions = (
  context: UserContext,
  filter: string,
  limit: number,
) =>
  Effect.gen(function* () {
    if (limit <= 0) return []

    const providerUserQueries = yield* ProviderUserQueries
    const auth = yield* AuthorizationService
    const principal = yield* buildStepPrincipal(context)
    const currentProviderUser = context.userId
      ? yield* providerUserQueries.queryProviderUserByUserId(context.userId)
      : Option.none()
    const suggestions: Array<{ value: string; label: string }> = []
    // Scan bounded pages so denied or roleless rows do not force an unbounded lookup.
    const pageSize = Math.max(limit * 5, 50)
    let offset = 0

    while (
      suggestions.length < limit &&
      offset < PROVIDER_USER_LOOKUP_MAX_SCANNED
    ) {
      const providerUsers = yield* providerUserQueries.queryProviderUsers(
        filter,
        {
          offset,
          limit: Math.min(pageSize, PROVIDER_USER_LOOKUP_MAX_SCANNED - offset),
        },
      )
      if (providerUsers.length === 0) break
      offset += providerUsers.length
      const rolePathsByProviderUserId =
        yield* providerUserQueries.queryProviderUserRolePathsByProviderUserIds(
          providerUsers.map((providerUser) => providerUser.id),
        )

      for (const providerUser of providerUsers) {
        const rolePaths = rolePathsByProviderUserId.get(providerUser.id) ?? []
        if (rolePaths.length === 0) continue

        // Candidate-level Cedar checks keep suggestions policy-accurate; the
        // bounded scan above caps the cost when many candidates are denied.
        const allowed = isCurrentProviderUser(
          providerUser,
          currentProviderUser,
          context,
        )
          ? true
          : yield* auth.canActOnBehalfOf(
              principal,
              new ProviderUserPrincipal(providerUser.email, {
                roles: rolePaths,
                // Cedar org-unit entity ids are path-based in GraphQL auth.
                orgUnitId: providerUser.orgUnitPath,
              }),
            )

        if (!allowed) continue

        suggestions.push({
          value: providerUser.id,
          label: providerUserLabel(providerUser),
        })

        if (suggestions.length >= limit) break
      }
    }

    return suggestions
  })

const hasProviderUserInput = (fieldSchema: Schema.Top): boolean =>
  Option.isSome(getSchemaAnnotationDeep(fieldSchema, FormProviderUserInput))

const resolveMaybeEffect = <T>(
  value: T | Effect.Effect<T, unknown, unknown>,
) => (Effect.isEffect(value) ? value : Effect.succeed(value))

type InvitationValidationResult =
  | {
      readonly success: false
      readonly error: string
    }
  | {
      readonly success: true
      readonly normalizedEmail: string
      readonly roles: readonly SettingsRoleRow[]
    }

const toGraphQLInvitationStatus = (
  status: SettingsInvitationRow["status"],
): "PENDING" | "ACCEPTED" | "LEGACY_CLOSED" => {
  if (status === InvitationLifecycleStatus.Accepted) {
    return "ACCEPTED"
  }
  if (status === InvitationLifecycleStatus.LegacyClosed) {
    return "LEGACY_CLOSED"
  }
  return "PENDING"
}

const fromGraphQLInvitationStatus = (
  status: "PENDING" | "ACCEPTED" | "LEGACY_CLOSED" | null | undefined,
): SettingsInvitationRow["status"] => {
  if (status === "ACCEPTED") {
    return InvitationLifecycleStatus.Accepted
  }
  if (status === "LEGACY_CLOSED") {
    return InvitationLifecycleStatus.LegacyClosed
  }
  return InvitationLifecycleStatus.Pending
}

const toGraphQLRegistrationLinkStatus = (
  status: SettingsInvitationRow["registrationLinkStatus"],
): "NOT_GENERATED" | "ACTIVE" | "EXPIRED" | "REVOKED" => {
  if (status === RegistrationLinkStatus.Active) {
    return "ACTIVE"
  }
  if (status === RegistrationLinkStatus.Expired) {
    return "EXPIRED"
  }
  if (status === RegistrationLinkStatus.Revoked) {
    return "REVOKED"
  }
  return "NOT_GENERATED"
}

const toGraphQLInvitation = (invitation: SettingsInvitationRow) => ({
  id: invitation.id,
  email: invitation.email,
  status: toGraphQLInvitationStatus(invitation.status),
  roles: invitation.roles,
  acceptedAt: invitation.acceptedAt,
  acceptedByProvider: invitation.acceptedByProvider,
  acceptedBySubject: invitation.acceptedBySubject,
  acceptedByProviderUserId: invitation.acceptedByProviderUserId,
  legacyClosedAt: invitation.legacyClosedAt,
  legacyClosureReason: invitation.legacyClosureReason,
  registrationLinkStatus: toGraphQLRegistrationLinkStatus(
    invitation.registrationLinkStatus,
  ),
  registrationLinkExpiresAt: invitation.registrationLinkExpiresAt,
  registrationLinkGeneratedAt: invitation.registrationLinkGeneratedAt,
  registrationLinkGeneratedBy:
    invitation.registrationLinkGeneratedBy === null
      ? null
      : actorDisplayLabel(invitation.registrationLinkGeneratedBy),
  registrationLinkRevealedAt: invitation.registrationLinkRevealedAt,
  registrationLinkRevealedBy:
    invitation.registrationLinkRevealedBy === null
      ? null
      : actorDisplayLabel(invitation.registrationLinkRevealedBy),
  registrationLinkRevokedAt: invitation.registrationLinkRevokedAt,
  registrationLinkRevokedBy:
    invitation.registrationLinkRevokedBy === null
      ? null
      : actorDisplayLabel(invitation.registrationLinkRevokedBy),
})

const existingProviderUserInvitationMessage =
  "A user with this email already exists. Manage that user's roles instead of creating an invitation."

const noLiveRegistrationLinkToRevokeMessage =
  "There is no live registration link to revoke."

const resolveRegistrationLinkOrganisationScope = (): string =>
  process.env["PF_SCOPE"] ?? process.env["PF_ORG"] ?? "local"

/**
 * Trusted frontend origin for Registration Link URLs.
 * Never derived from an unchecked Host header.
 */
const resolveRegistrationLinkFrontendOrigin = (): string | null => {
  const configured =
    process.env["FRONTEND_BASE_URL"] ??
    process.env["BASE_URL"] ??
    process.env["NEXT_PUBLIC_FRONTEND_URL"]
  if (configured) {
    return configured.replace(/\/$/, "")
  }
  const nodeEnv = process.env["NODE_ENV"]
  if (nodeEnv === "development" || nodeEnv === "test") {
    return "http://localhost:3000"
  }
  return null
}

class InvitationCreationFailed extends Data.TaggedError(
  "InvitationCreationFailed",
)<{ readonly message: string }> {}

const validateInvitationMutationInput = (
  settingsQueries: typeof SettingsQueries.Service,
  input: InvitationMutationInput,
  currentInvitationId?: string,
) =>
  Effect.gen(function* () {
    const emailResult = Schema.decodeUnknownResult(Email)(input.email.trim())
    if (Result.isFailure(emailResult)) {
      return {
        success: false,
        error: "Enter a valid email address",
      } satisfies InvitationValidationResult
    }

    if (input.roleIds.length === 0) {
      return {
        success: false,
        error: "Select at least one role",
      } satisfies InvitationValidationResult
    }

    const normalizedEmail = emailResult.success.toLowerCase()
    const roles = yield* settingsQueries.queryRolesByIds(input.roleIds)
    const rolesById = new Map(roles.map((role) => [role.id, role]))
    const invalidRoleIds = input.roleIds.filter((id) => !rolesById.has(id))
    if (invalidRoleIds.length > 0) {
      return {
        success: false,
        error: `Invalid role IDs: ${invalidRoleIds.join(", ")}`,
      } satisfies InvitationValidationResult
    }

    const existingProviderUser =
      yield* settingsQueries.queryProviderUserByEmail(normalizedEmail)
    if (existingProviderUser) {
      return {
        success: false,
        error: existingProviderUserInvitationMessage,
      } satisfies InvitationValidationResult
    }

    const existingPendingInvitation =
      yield* settingsQueries.queryPendingInvitationByEmail(normalizedEmail)
    if (
      existingPendingInvitation &&
      existingPendingInvitation.id !== currentInvitationId
    ) {
      return {
        success: false,
        error: `A pending invitation already exists for: ${normalizedEmail}`,
      } satisfies InvitationValidationResult
    }

    return {
      success: true,
      normalizedEmail,
      roles: input.roleIds.flatMap((roleId) => {
        const role = rolesById.get(roleId)
        return role ? [role] : []
      }),
    } satisfies InvitationValidationResult
  })

export const systemSchema = Effect.gen(function* () {
  // Load system schema from the graphql-schema package using package exports
  const fs = yield* FileSystem.FileSystem
  const schemaRoot = process.env["PF_GRAPHQL_SCHEMA_ROOT"]
  const schemaPath = schemaRoot
    ? join(schemaRoot, "system.graphql")
    : fileURLToPath(import.meta.resolve("@pf/graphql-schema/system.graphql"))
  const systemTypeDefs = yield* fs.readFileString(schemaPath)

  const orgQueries = yield* OrgQueries
  const processQueries = yield* ProcessQueries
  const providerUserQueries = yield* ProviderUserQueries
  const workflowQueries = yield* WorkflowQueries

  // The catalog's Step permission is necessary but does not guarantee that
  // the current model has a callable start mutation.
  const startMutationRows = <Row extends { startStepPath: string }>(
    context: UserContext,
    rows: readonly Row[],
  ) =>
    Effect.gen(function* () {
      const { organisation } = yield* OrganisationProvider
      const auth = yield* AuthorizationService
      const principal = yield* buildPrincipal(context)
      const result: Row[] = []
      for (const row of rows) {
        const step = organisation.stepByPath(row.startStepPath)
        if (!step) continue
        const starts = step.process.startNodes()
        if (
          starts.length !== 1 ||
          normalizePath(starts[0]?.node.path ?? "") !== row.startStepPath
        )
          continue
        if (step.process.props.cron && step.isSystemStep) {
          const allowed = yield* auth.canAccessField(
            principal,
            new GraphQLField(
              `Mutation.${step.process.startMutationName()}`,
              "cron",
            ),
            "mutation",
          )
          if (!allowed) continue
        }
        result.push(row)
      }
      return result
    })

  const resolveHiddenFormFieldNames = ({
    form,
    stepPath,
    context,
  }: {
    readonly form: Form
    readonly stepPath: string
    readonly context: UserContext
  }) =>
    Effect.gen(function* () {
      const hiddenFieldNames = new Set<string>()
      if (!form.output) return hiddenFieldNames

      const restrictedFields: Array<{
        readonly fieldName: string
        readonly rolePath: string
      }> = []

      for (const [fieldName, field] of Object.entries(
        getSubmissionFields(form.output),
      )) {
        const permission = getSchemaAnnotationDeep(
          field as Schema.Top,
          FormPermission,
        )
        if (!Option.isSome(permission)) continue
        if (!isFieldPermissionMetadata(permission.value)) continue

        restrictedFields.push({
          fieldName,
          rolePath: normalizePath(permission.value.modify.node.path),
        })
      }

      if (restrictedFields.length === 0) return hiddenFieldNames

      const process = form.process
      const stepRoleQueries = yield* StepRoleQueries
      const stepRoleInfo =
        yield* stepRoleQueries.queryRolePathsByStepPath(stepPath)
      const fieldAccess = yield* Effect.all(
        restrictedFields.map((field) =>
          canModifyField(context, {
            stepPath,
            fieldName: field.fieldName,
            rolePath: field.rolePath,
            stepRolePath: stepRoleInfo.rolePath,
            processPath: process.node.path,
            orgUnitId: process.orgUnit.node.path,
            stepStartsProcess: stepRoleInfo.startsProcess,
            stepEmbedded: stepRoleInfo.embedded,
          }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("formMetadata: modifyField check failed", {
                error,
                fieldName: field.fieldName,
                stepPath,
              }),
            ),
            Effect.catch(() => Effect.succeed(false)),
            Effect.map((allowed) => ({
              fieldName: field.fieldName,
              allowed,
            })),
          ),
        ),
        { concurrency: "unbounded" },
      )

      for (const field of fieldAccess) {
        if (!field.allowed) hiddenFieldNames.add(field.fieldName)
      }

      return hiddenFieldNames
    })

  const resolveFormMetadata = (
    args: { stepPath: string; todoId?: string | null },
    context: UserContext,
    authorization: "complete" | "viewEmbeddedForm" | "publicLink",
  ) =>
    Effect.gen(function* () {
      const { organisation: org } = yield* OrganisationProvider
      const authorizationMessage =
        authorization !== "publicLink"
          ? `User ${context._userDetails.by} is not authorized to complete step ${args.stepPath}`
          : `This public link is not authorized to complete step ${args.stepPath}`

      const step = org.stepByPath(args.stepPath)

      if (!step) {
        yield* Effect.logWarning("formMetadata: step not found", {
          stepPath: args.stepPath,
        })
        return yield* new NotAuthorized({
          action: "complete",
          resource: args.stepPath,
          message: authorizationMessage,
        })
      }

      if (authorization !== "publicLink") {
        yield* checkStepAuthorization(context, args.stepPath, authorization)
      }

      const process = step.process
      const processPath = process.node.path
      const processName = process.props.name
      const stepName = step.props.name ?? step.node.id

      const isStartStep = process
        .startNodes()
        .some(
          (startNode) =>
            normalizePath(startNode.node.path) ===
            normalizePath(step.node.path),
        )

      const stepFullPath = step.node.path
      const pascalPath = pathToPascalCase(stepFullPath)
      const mutationName = process.startMutationName()
      const form = org.formByPath(args.stepPath)

      if (!form) {
        if (!isStartStep) {
          yield* Effect.logWarning(
            "formMetadata: non-form step requested outside process start",
            { stepPath: args.stepPath },
          )
          return yield* new NotAuthorized({
            action: "complete",
            resource: args.stepPath,
            message: authorizationMessage,
          })
        }

        return {
          stepPath: args.stepPath,
          processName,
          stepName,
          publicFormTitle: null,
          publicFormDescription: null,
          processPath,
          mutationName,
          inputTypeName: "",
          completeMutationName: "",
          totalFields: 0,
          defaultValues: null,
        }
      }

      const inputTypeName = pascalPath
      const completeMutationName = `complete${pascalPath}`

      if (!form.output) {
        return {
          stepPath: args.stepPath,
          processName,
          stepName,
          publicFormTitle: form.publicCompletion?.formTitle ?? null,
          publicFormDescription: form.publicCompletion?.formDescription ?? null,
          processPath,
          mutationName,
          inputTypeName,
          completeMutationName,
          totalFields: 0,
          defaultValues: null,
        }
      }

      const currentProviderUser = currentProviderUserDefault(context)
      let defaultValues: Record<string, unknown> =
        yield* form.resolveInitialDefaults(currentProviderUser)

      // The organisation artifact supplies the executable definition. Only request data crosses here.
      if (isStartStep || args.todoId) {
        let state: Record<string, unknown> = {}
        let ctx = startFormContext(context)
        let item: unknown
        if (args.todoId) {
          const operations = yield* StepCompletionOperations
          const execution = yield* operations.getProcessStateByTodoId(
            args.todoId,
          )
          if (!execution)
            return yield* new ProcessStateNotFound({
              todoId: args.todoId,
              stepPath: args.stepPath,
              message: "Process state not found",
            })
          state = execution.state
          ctx = buildFlowContext(
            execution.processExecutionId,
            execution.processStartedAt,
            yield* operations.getCompletedStepsForExecution(
              execution.processExecutionId,
            ),
          ) as FlowContext<Record<string, never>>
          item =
            (yield* operations.queryTodoById(args.todoId))?.itemData ??
            undefined
        }
        const pluginConfiguration = form.browser?.resolvePluginConfiguration
          ? yield* form.browser?.resolvePluginConfiguration()
          : {}
        defaultValues = yield* form.resolveDefaults(
          state,
          ctx,
          item,
          currentProviderUser,
        )
        const inaccessible = yield* resolveHiddenFormFieldNames({
          form,
          stepPath: args.stepPath,
          context,
        })
        const originalValues = yield* form.resolveOriginalValues(
          state,
          ctx,
          item,
          currentProviderUser,
        )
        const presentation = Object.fromEntries(
          Object.entries(form.resolvePresentation(state, ctx, item)).filter(
            ([path]) =>
              !inaccessible.has(form.submissionPath(path.split(".")).join(".")),
          ),
        )
        const prefill = form.prefillQuery()
        return {
          stepPath: args.stepPath,
          processName,
          stepName,
          publicFormTitle: form.publicCompletion?.formTitle ?? null,
          publicFormDescription: form.publicCompletion?.formDescription ?? null,
          processPath,
          mutationName,
          inputTypeName,
          completeMutationName,
          pluginConfiguration: Object.fromEntries(
            Object.entries(pluginConfiguration).filter(
              ([path]) => !inaccessible.has(path),
            ),
          ),
          totalFields: countLeafFields(
            Object.fromEntries(
              Object.entries(defaultValues).filter(
                ([key]) => !inaccessible.has(key),
              ),
            ),
          ),
          defaultValues: Object.fromEntries(
            Object.entries(defaultValues).filter(
              ([key]) => !inaccessible.has(key),
            ),
          ),
          requestData: {
            presentation,
            originalValues: Object.fromEntries(
              Object.entries(originalValues).filter(
                ([key]) => !inaccessible.has(key),
              ),
            ),
            inaccessible: [...inaccessible],
            lookups: Object.fromEntries(
              [...form.lookupOverrides()]
                .filter(([name]) => !inaccessible.has(name))
                .map(([name, override]) => [
                  name,
                  {
                    dependencies: override.dependencies ?? [],
                    queryName: form.lookupQueryName(name),
                  },
                ]),
            ),
            ...(prefill
              ? {
                  prefill: {
                    dependency: prefill.dependency,
                    fields: prefill.fields,
                    concealed: prefill.concealed,
                    queryName: form.prefillQueryName(),
                  },
                }
              : {}),
          },
        }
      }

      // Workflow previews have no execution context. Resolve only static defaults.
      const inaccessible = yield* resolveHiddenFormFieldNames({
        form,
        stepPath: args.stepPath,
        context,
      })
      const visibleDefaults = Object.fromEntries(
        Object.entries(defaultValues).filter(([key]) => !inaccessible.has(key)),
      )
      return {
        stepPath: args.stepPath,
        processName,
        stepName,
        publicFormTitle: form.publicCompletion?.formTitle ?? null,
        publicFormDescription: form.publicCompletion?.formDescription ?? null,
        processPath,
        mutationName,
        inputTypeName,
        completeMutationName,
        totalFields: countLeafFields(visibleDefaults),
        defaultValues: visibleDefaults,
        requestData: {
          inaccessible: [...inaccessible],
          presentation: {},
          originalValues: {},
        },
      }
    })

  const loadTodoFormExecutionContext = (args: {
    readonly todoId: string
    readonly stepPath: string
    readonly field: string
    readonly action: string
    readonly unauthorizedMessage: string
  }) =>
    Effect.gen(function* () {
      const stepCompletionOps = yield* StepCompletionOperations
      const processStateData = yield* stepCompletionOps.getProcessStateByTodoId(
        args.todoId,
      )

      if (!processStateData) {
        return yield* new ProcessStateNotFound({
          todoId: args.todoId,
          stepPath: args.stepPath,
          message: `Process state not found for todo "${args.todoId}"`,
        })
      }

      const completedSteps =
        yield* stepCompletionOps.getCompletedStepsForExecution(
          processStateData.processExecutionId,
        )
      const ctx = buildFlowContext(
        processStateData.processExecutionId,
        processStateData.processStartedAt,
        completedSteps,
      )
      const todoInfo = yield* stepCompletionOps.queryTodoById(args.todoId)
      if (
        !todoInfo ||
        normalizePath(todoInfo.targetStepPath) !==
          normalizePath(args.stepPath) ||
        todoInfo.processExecutionId !== processStateData.processExecutionId
      ) {
        return yield* new NotAuthorized({
          action: args.action,
          resource: args.field,
          message: args.unauthorizedMessage,
        })
      }

      return {
        ctx: ctx as FlowContext<Record<string, StepMeta>>,
        itemData: todoInfo.itemData ?? undefined,
        state: processStateData.state,
      }
    })

  const validatePublicTodoCapability = (
    token: string,
    _context: UserContext,
    options: { readonly allowExpired?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      return yield* inspectPublicCompletion({
        capability: yield* decryptPublicTodoToken(token),
        ...options,
      })
    })

  const resolvePublicTodo = (token: string, context: UserContext) =>
    Effect.gen(function* () {
      const capability = yield* validatePublicTodoCapability(token, context)
      if (capability.type === "done") {
        return { ...capability.result, formMetadata: null }
      }

      const { payload, stepPath } = capability
      const { organisation: org } = yield* OrganisationProvider
      const formMetadata = yield* resolveFormMetadata(
        { stepPath, todoId: payload.tid },
        context,
        "publicLink",
      )

      return {
        todoId: payload.tid,
        status: "ACTIVE",
        organisationName: org.name,
        formMetadata,
      } satisfies PublicTodoResult
    })

  const completePublicTodo = (
    token: string,
    input: Record<string, unknown>,
    context: UserContext,
  ) =>
    Effect.gen(function* () {
      const result = yield* submitPublicCompletion({
        capability: yield* decryptPublicTodoToken(token),
        input,
        identity: executionIdentity(context),
      })
      return { ...result, formMetadata: null }
    })

  const queryPublicCompletionCorrection = (
    todoId: string,
    context: UserContext,
  ) =>
    Effect.gen(function* () {
      const stepCompletionOps = yield* StepCompletionOperations
      const todo = yield* stepCompletionOps.queryTodoById(todoId)
      if (!todo?.correctionRequiredAt) return null

      yield* checkPublicCompletionCorrectionAuthorization(context, {
        id: todo.id,
        stepPath: todo.targetStepPath,
        processPath: todo.processPath,
        processOrgUnitPath: todo.orgUnitPath,
        assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
      })

      const correctionRecipient =
        yield* stepCompletionOps.queryPublicCompletionCorrectionRecipient(
          todoId,
        )
      if (!correctionRecipient) return null

      const { organisation: org } = yield* OrganisationProvider
      const form = org.formByPath(todo.targetStepPath)
      if (!form?.publicCompletion?.correction) return null

      return {
        todoId,
        processName: form.process.props.name,
        stepName:
          form.props.name ??
          todo.targetStepPath.split("/").at(-1) ??
          todo.targetStepPath,
        correctedEmail: correctionRecipient.recipientEmail,
        failureReason: correctionRecipient.failureReason,
      }
    })

  const submitPublicCompletionCorrection = (
    todoId: string,
    correctedEmail: string,
    context: UserContext,
  ) =>
    correctPublicCompletion({
      todoId,
      correctedEmail,
      identity: executionIdentity(context),
    })

  const publicTodoLookupSuggestions = (
    args: {
      token: string
      field: string
      filter?: string | null
      limit?: number | null
      selectedValue?: string | null
    },
    context: UserContext,
  ) =>
    Effect.gen(function* () {
      const capability = yield* validatePublicTodoCapability(
        args.token,
        context,
      )
      if (capability.type === "done") {
        // Completed/expired public tokens should not reveal lookup data.
        return []
      }

      const { payload, form, stepPath } = capability
      const fieldSchema = getSubmissionFields(form.output)[args.field]
      if (!fieldSchema) {
        return yield* new LookupFieldNotFoundError({
          fieldName: args.field,
          formStep: stepPath,
          message: `Lookup field "${args.field}" not found in public form "${stepPath}"`,
        })
      }

      // Admission uses the submission schema and server permissions, without
      // resolving request-local presentation or constructing component trees.
      const hiddenFieldNames = yield* resolveHiddenFormFieldNames({
        form,
        stepPath,
        context,
      })
      if (hiddenFieldNames.has(args.field)) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public lookup field ${args.field} is not authorized`,
        })
      }
      const lookupOverride = form.lookupOverrides().get(args.field)
      if (lookupOverride?.dependencies?.length) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public dependent lookup field ${args.field} is not authorized`,
        })
      }

      if (form.lookupOverrides().has(args.field)) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public lookup field ${args.field} is not authorized`,
        })
      }

      if (
        Option.isSome(
          getSchemaAnnotationDeep(fieldSchema as Schema.Top, FormPermission),
        )
      ) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public permission-gated lookup field ${args.field} is not authorized`,
        })
      }

      if (hasProviderUserInput(fieldSchema as Schema.Top)) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public provider-user lookup field ${args.field} is not authorized`,
        })
      }

      const metadata = getSchemaAnnotationDeep(
        fieldSchema as Schema.Top,
        FormLookupInput,
      ).pipe(Option.getOrUndefined) as LookupFieldMetadata | undefined
      if (!metadata?.query) {
        return yield* new LookupFieldNotFoundError({
          fieldName: args.field,
          formStep: stepPath,
          message: `Field "${args.field}" in public form "${stepPath}" is not a lookup field`,
        })
      }

      const stepCompletionOps = yield* StepCompletionOperations
      const processStateData = yield* stepCompletionOps.getProcessStateByTodoId(
        payload.tid,
      )
      if (!processStateData) {
        return yield* new ProcessStateNotFound({
          todoId: payload.tid,
          stepPath,
          message: `Process state not found for todo "${payload.tid}"`,
        })
      }

      const todoInfo = yield* stepCompletionOps.queryTodoById(payload.tid)
      if (
        !todoInfo ||
        normalizePath(todoInfo.targetStepPath) !== normalizePath(stepPath) ||
        todoInfo.processExecutionId !== processStateData.processExecutionId
      ) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public lookup todo ${payload.tid} is not authorized for step ${stepPath}`,
        })
      }

      const completedSteps =
        yield* stepCompletionOps.getCompletedStepsForExecution(
          processStateData.processExecutionId,
        )
      const ctx = buildFlowContext(
        processStateData.processExecutionId,
        processStateData.processStartedAt,
        completedSteps,
      )
      // Capability validation returned this exact public form, so it is safe to
      // reintroduce the generic state shape required by lookup execution.
      const statefulForm = form as Form<
        Record<string, unknown>,
        Record<string, StepMeta>,
        Schema.Struct.Fields,
        string,
        unknown
      >
      const localMax = metadata.mode === "local" ? metadata.maxItems : undefined
      if (args.selectedValue != null) {
        const item = yield* statefulForm.resolveLookupSelection(
          args.field,
          args.selectedValue,
          statefulForm.getFieldsWithState(
            processStateData.state,
            ctx as FlowContext<Record<string, StepMeta>>,
            todoInfo.itemData ?? undefined,
          ),
        )
        return item ? [item] : []
      }
      const filter = localMax === undefined ? (args.filter ?? "") : ""
      const limit =
        localMax === undefined
          ? Math.max(0, Math.min(args.limit ?? 20, 100))
          : localMax + 1

      return yield* statefulForm.executeLookupWithState(
        args.field,
        filter,
        limit,
        processStateData.state,
        ctx as FlowContext<Record<string, StepMeta>>,
        todoInfo.itemData ?? undefined,
      )
    })

  const publicTodoCalendarSlots = (
    args: {
      token: string
      field: string
    },
    context: UserContext,
  ) =>
    Effect.gen(function* () {
      const capability = yield* validatePublicTodoCapability(
        args.token,
        context,
      )
      if (capability.type === "done") {
        return []
      }

      const { payload, form, stepPath } = capability
      const fieldSchema = getSubmissionFields(form.output)[args.field]
      if (!fieldSchema) {
        return yield* new LookupFieldNotFoundError({
          fieldName: args.field,
          formStep: stepPath,
          message: `Calendar slot field "${args.field}" not found in public form "${stepPath}"`,
        })
      }

      // Inspect the static submission contract, not request presentation.
      const hiddenFieldNames = yield* resolveHiddenFormFieldNames({
        form,
        stepPath,
        context,
      })
      if (
        hiddenFieldNames.has(args.field) ||
        Option.isNone(
          getSchemaAnnotationDeep(
            fieldSchema as Schema.Top,
            FormCalendarSlotInput,
          ),
        )
      ) {
        return yield* new NotAuthorized({
          action: "calendarSlots",
          resource: args.field,
          message: `Public calendar slot field ${args.field} is not authorized`,
        })
      }

      if (
        Option.isSome(
          getSchemaAnnotationDeep(fieldSchema as Schema.Top, FormPermission),
        )
      ) {
        return yield* new NotAuthorized({
          action: "calendarSlots",
          resource: args.field,
          message: `Public permission-gated calendar slot field ${args.field} is not authorized`,
        })
      }

      const metadata = Option.getOrUndefined(
        getSchemaAnnotationDeep(
          fieldSchema as Schema.Top,
          FormCalendarSlotInput,
        ),
      ) as CalendarSlotFieldMetadata | undefined
      if (!metadata?.query) {
        return yield* new LookupFieldNotFoundError({
          fieldName: args.field,
          formStep: stepPath,
          message: `Field "${args.field}" in public form "${stepPath}" is not a calendar slot field`,
        })
      }

      const executionContext = yield* loadTodoFormExecutionContext({
        todoId: payload.tid,
        stepPath,
        field: args.field,
        action: "calendarSlots",
        unauthorizedMessage: `Public calendar slot todo ${payload.tid} is not authorized for step ${stepPath}`,
      })
      const statefulForm = form as Form<
        Record<string, unknown>,
        Record<string, StepMeta>,
        Schema.Struct.Fields,
        string,
        unknown
      >

      return yield* statefulForm.executeCalendarSlotsWithState(
        args.field,
        executionContext.state,
        executionContext.ctx,
        executionContext.itemData,
      )
    })

  const requestFreshPublicTodoLink = (token: string, _context: UserContext) =>
    Effect.gen(function* () {
      return yield* renewPublicCompletionInvitation({
        capability: yield* decryptPublicTodoToken(token),
      })
    })

  const resolvers: ResolverMap = {
    FormMetadata: {
      processId: (parent: unknown) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({ processPath: Schema.String }),
        )(parent).pipe(
          Effect.orDie,
          Effect.flatMap(({ processPath }) =>
            processQueries.listProcesses({
              processPath: normalizePath(processPath),
              offset: 0,
              limit: 1,
            }),
          ),
          Effect.map((rows) => rows[0]?.id ?? null),
        ),
      canSkipScheduleWaits: (
        parent: unknown,
        _args: unknown,
        context: UserContext,
      ) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({ processPath: Schema.String }),
        )(parent).pipe(
          Effect.orDie,
          Effect.flatMap(({ processPath }) =>
            canSkipScheduleWaits(context, normalizePath(processPath)),
          ),
          Effect.catch(() => Effect.succeed(false)),
        ),
    },
    SettingsUserDetail: {
      taskAssignmentEmailAvailable: () =>
        Effect.gen(function* () {
          const { organisation } = yield* OrganisationProvider
          const layer = organisation.notificationEmailLayer?.()
          if (layer === undefined) return false
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(layer)
              const config = Context.getOrUndefined(
                services,
                NotificationDeliveryConfig,
              )
              const sender = Context.getOrUndefined(services, EmailSender)
              return (
                config?.getSenderIdentity() !== undefined &&
                sender !== undefined &&
                !sender.loggingOnly
              )
            }),
          ).pipe(Effect.catch(() => Effect.succeed(false)))
        }),
    },
    Query: {
      deploymentProbe: (
        _parent: unknown,
        args: { input: unknown },
        context: UserContext,
      ) => resolveDeploymentProbe("status", args.input, context),
      delegatedSession: (
        _parent: unknown,
        _args: unknown,
        context: UserContext,
      ) => {
        const session = context.jwt?.properties
        return session && "delegation" in session && session.delegation
          ? Effect.succeed(session)
          : Effect.fail(
              new NotAuthorized({
                action: "login",
                resource: "GraphQL",
                message: "Delegated session required",
              }),
            )
      },
      org: () =>
        orgQueries.queryRoot.pipe(
          Effect.map((o): ResolversTypes["OrgUnit"] | null | undefined => {
            if (o) {
              return mapOrgUnit(o)
            } else return o
          }),
        ),
      cedarPolicies: () =>
        Effect.gen(function* () {
          const cedarConfig = yield* LocalCedarConfig
          const policyWatcher =
            yield* Effect.serviceOption(PolicyWatcherService)
          const policies = Option.isSome(policyWatcher)
            ? yield* policyWatcher.value.currentPolicies
            : cedarConfig.policiesText

          return {
            policies,
            schema: cedarConfig.schemaText,
          }
        }),
      orgLevels: () => orgQueries.queryOrgLevels,
      processes: (
        _parent: unknown,
        args: {
          readonly page: number
          readonly limit: number
          readonly processPath?: string | null
          readonly status?: string | null
          readonly requireStartMutation?: boolean
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const pagination = clampPaginationWindow(args)
          yield* validateProcessListStatus(args.status)

          return yield* queryAuthorizedPage({
            pagination,
            queryRows: (window) =>
              processQueries.listProcesses({
                ...window,
                processPath: args.processPath,
              }),
            authorizeRows: (rows) =>
              filterAuthorizedProcessRows(context, rows).pipe(
                Effect.flatMap((authorized) =>
                  args.requireStartMutation
                    ? startMutationRows(context, authorized)
                    : Effect.succeed(authorized),
                ),
              ),
          })
        }),
      processStartForm: (
        _parent: unknown,
        args: { processPath: string; input?: unknown },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const path = normalizePath(args.processPath)
          const rows = yield* processQueries.listProcesses({
            processPath: path,
            offset: 0,
            limit: 1,
          })
          const [process] = yield* filterAuthorizedProcessRows(
            context,
            rows,
          ).pipe(
            Effect.flatMap((authorized) =>
              startMutationRows(context, authorized),
            ),
          )
          if (!process) return null

          const input = yield* Schema.decodeUnknownEffect(
            Schema.Record(Schema.String, Schema.Unknown),
          )(args.input ?? {}).pipe(
            Effect.mapError(
              () =>
                new InputValidationError({
                  errors: [{ field: "input", message: "Expected an object" }],
                }),
            ),
          )
          const { organisation } = yield* OrganisationProvider
          const step = organisation.stepByPath(process.startStepPath)
          if (!step) return null
          const form = organisation.formByPath(process.startStepPath)
          const base = {
            startStepPath: process.startStepPath,
            mutationName: step.process.startMutationName(),
            inputTypeName: null,
            fields: [],
            defaultValues: {},
            errors: [],
            requiresDashboard: false,
            unconfirmedDefaults: [],
            submissionInput: {},
          }
          if (!form || Object.keys(form.output ?? {}).length === 0) return base

          const metadata = yield* resolveFormMetadata(
            { stepPath: process.startStepPath },
            context,
            "complete",
          )
          const requestData = yield* Schema.decodeUnknownEffect(
            FormRequestData,
          )(metadata.requestData)
          const defaults = yield* resolveFormFieldDefaults(
            getSubmissionFields(
              form.getFieldsWithState({}, startFormContext(context)),
            ),
            currentProviderUserDefault(context),
          )
          const defaultValues = Object.fromEntries(
            Object.entries(defaults).filter(
              ([key]) => !requestData.inaccessible.includes(key),
            ),
          )
          return {
            ...base,
            inputTypeName: metadata.inputTypeName,
            defaultValues,
            ...projectProcessStartForm({
              schema: form.sharedSchema,
              defaults: defaultValues,
              requestData,
              input,
            }),
          }
        }),
      todos: (
        _parent: unknown,
        args: {
          readonly page: number
          readonly limit: number
          readonly processPath?: string | null
          readonly status?: string | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const todoQueries = yield* TodoQueries
          const summaryComputation = yield* TodoSummaryComputation
          const pagination = clampPaginationWindow(args)
          const state = yield* parseTodoListStatusPredicate(args.status)
          const page = yield* queryAuthorizedPage({
            pagination,
            queryRows: (window) =>
              todoQueries.listTodos({
                ...window,
                processPath: args.processPath,
                state,
              }),
            authorizeRows: (rows) => filterAuthorizedTodoRows(context, rows),
          })
          const nodes = yield* summaryComputation.enrichWithSummaries(
            page.nodes,
          )

          return {
            ...page,
            nodes: nodes.map((todo) => ({
              id: todo.id,
              processExecutionId: todo.processExecutionId,
              processName: todo.processName,
              stepName: todo.stepName,
              stepPath: todo.stepPath,
              role: todo.role ?? "System",
              status: todo.status,
              priority: todo.priority,
              assignedAt: todo.assignedAt,
              dueAt: todo.dueAt,
              description: todo.description,
              summary: todo.summary,
            })),
          }
        }),
      execution: (
        _parent: unknown,
        args: { readonly id: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const executionOps = yield* ExecutionCollectionOps
          const [row] = yield* executionOps.getByIds([args.id])
          if (!row) return null

          const principal = yield* buildStepPrincipal(context)
          const document = yield* executionOps.mapToGraphql(row)
          const [authorized] = yield* filterAuthorizedExecutions(
            [document],
            principal,
          )
          return authorized ?? null
        }),
      executions: (
        _parent: unknown,
        args: {
          readonly page: number
          readonly limit: number
          readonly processPath?: string | null
          readonly status?: string | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const executionOps = yield* ExecutionCollectionOps
          const principal = yield* buildStepPrincipal(context)
          const pagination = clampPaginationWindow(args)
          const status = yield* parseExecutionListStatus(args.status)
          const page = yield* queryAuthorizedPage({
            pagination,
            queryRows: (window) =>
              executionOps.list({
                ...window,
                processPath: args.processPath,
              }),
            authorizeRows: (rows) =>
              filterAuthorizedExecutionRows(
                principal,
                status === undefined
                  ? rows
                  : rows.filter((row) => row.execution.status === status),
              ),
          })
          const nodes = yield* Effect.all(
            page.nodes.map((row) => executionOps.mapToGraphql(row)),
            { concurrency: "unbounded" },
          )

          return {
            ...page,
            nodes: nodes.map((execution) => ({
              id: execution.id,
              processPath: execution.processPath,
              processName: execution.processName,
              status: execution.status,
              startedAt: execution.startedAt,
              finishedAt: execution.finishedAt,
              completedSteps: execution.completedSteps,
              withoutWaiting: execution.withoutWaiting ?? false,
              totalSteps: execution.totalSteps,
              failureReason: execution.failureReason,
            })),
          }
        }),

      currentProviderUser: (
        _parent: unknown,
        _args: unknown,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          if (!context.userId) {
            return yield* new NoProviderUserID({
              message: "No provider user ID found in session context",
            })
          }

          const providerUserOption =
            yield* providerUserQueries.queryProviderUserByUserId(context.userId)

          if (Option.isNone(providerUserOption)) {
            return yield* new ProviderUserNotFound({
              userId: context.userId,
              message: `Provider user with ID ${context.userId} not found`,
            })
          }

          return providerUserOption.value
        }),

      formMetadata: (
        _parent: unknown,
        args: { stepPath: string; todoId?: string | null },
        context: UserContext,
      ) => resolveFormMetadata(args, context, "complete"),

      todoChatForm: (
        _parent: unknown,
        args: { todoId: string; answers: unknown },
        context: UserContext,
      ) =>
        decodeTodoChatAnswers(args.answers).pipe(
          Effect.flatMap((input) =>
            inspectTodoForm({
              todoId: args.todoId,
              input,
              identity: executionIdentity(context),
            }),
          ),
        ),

      embeddedFormMetadata: (
        _parent: unknown,
        args: { stepPath: string },
        context: UserContext,
      ) =>
        resolveFormMetadata(
          { stepPath: args.stepPath },
          context,
          "viewEmbeddedForm",
        ),

      publicCompletionCorrection: (
        _parent: unknown,
        args: { todoId: string },
        context: UserContext,
      ) => queryPublicCompletionCorrection(args.todoId, context),

      anonymousPage: (
        _parent: unknown,
        args: { address: string },
        context: UserContext,
      ) => anonymousPage(args.address, context),
      anonymousPageLookup: (
        _parent: unknown,
        args: {
          address: string
          field: string
          filter?: string | null
          limit?: number | null
          selectedValue?: string | null
        },
      ) => anonymousPageLookup(args),
      publicTodo: (
        _parent: unknown,
        args: { token: string },
        context: UserContext,
      ) => resolvePublicTodo(args.token, context),

      publicTodoLookupSuggestions: (
        _parent: unknown,
        args: {
          token: string
          field: string
          filter?: string | null
          limit?: number | null
          selectedValue?: string | null
        },
        context: UserContext,
      ) => publicTodoLookupSuggestions(args, context),

      publicTodoCalendarSlots: (
        _parent: unknown,
        args: {
          token: string
          field: string
        },
        context: UserContext,
      ) => publicTodoCalendarSlots(args, context),

      processWorkflow: (_parent: unknown, args: { processPath: string }) =>
        Effect.gen(function* () {
          const workflowData =
            yield* workflowQueries.queryWorkflowByProcessPath(args.processPath)

          const stepColumns = calculateStepColumns(
            workflowData.steps,
            workflowData.flows,
          )

          return {
            processId: workflowData.processId,
            processName: workflowData.processName,
            processPath: workflowData.processPath,
            processPurpose: workflowData.processPurpose,
            steps: workflowData.steps.map((s) => ({
              id: s.id,
              name: s.name,
              path: s.path,
              purpose: s.purpose,
              processId: s.processId,
              role:
                s.roleId && s.roleName && s.rolePath
                  ? {
                      id: s.roleId,
                      name: s.roleName,
                      path: s.rolePath,
                    }
                  : null,
              phase:
                s.phaseId && s.phaseName && s.phasePath && s.phaseOrder != null
                  ? {
                      id: s.phaseId,
                      name: s.phaseName,
                      path: s.phasePath,
                      order: s.phaseOrder,
                    }
                  : null,
              isStartStep: s.isStartStep,
              isEmbedded: s.isEmbedded,
              column: stepColumns.get(s.id) ?? 1,
            })),
            flows: workflowData.flows,
            responsibilities: workflowData.responsibilities.map((r) => ({
              roleId: r.roleId,
              roleName: r.roleName,
              rolePath: r.rolePath,
              responsibility: r.responsibility,
              order: r.order,
            })),
          }
        }),

      hasPendingScheduledFlows: (
        _parent: unknown,
        args: { processExecutionId: string },
      ) =>
        Effect.gen(function* () {
          const scheduledFlowOps = yield* ScheduledFlowOperations
          return yield* scheduledFlowOps.hasPendingScheduledFlows(
            args.processExecutionId,
          )
        }),

      publicCompletionUrl: (
        _parent: unknown,
        args: { todoId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const stepCompletionOps = yield* StepCompletionOperations
          const todo = yield* stepCompletionOps.queryTodoById(args.todoId)
          if (!todo) {
            return yield* new PublicCompletionInvitationNotFound({
              todoId: args.todoId,
              message: `No public completion invitation exists for todo "${args.todoId}"`,
            })
          }

          const latestInvitation =
            yield* stepCompletionOps.queryLatestPublicCompletionInvitationAttempt(
              args.todoId,
            )
          if (!latestInvitation) {
            return yield* new PublicCompletionInvitationNotFound({
              todoId: args.todoId,
              message: `No public completion invitation exists for todo "${args.todoId}"`,
            })
          }

          const { organisation } = yield* OrganisationProvider
          const form = organisation.formByPath(todo.targetStepPath) as
            | Form<
                Record<string, unknown>,
                Record<string, StepMeta>,
                Schema.Struct.Fields,
                string,
                unknown
              >
            | undefined
          const publicCompletion = form?.publicCompletion
          if (!publicCompletion) {
            return yield* new PublicCompletionInvitationNotFound({
              todoId: args.todoId,
              message: `No public completion invitation exists for todo "${args.todoId}"`,
            })
          }

          const processStateData =
            yield* stepCompletionOps.getProcessStateByTodoId(args.todoId)
          if (!processStateData) {
            return yield* new ProcessStateNotFound({
              todoId: args.todoId,
              stepPath: todo.targetStepPath,
              message: `Process state not found for todo "${args.todoId}"`,
            })
          }

          const completedSteps =
            yield* stepCompletionOps.getCompletedStepsForExecution(
              processStateData.processExecutionId,
            )
          const ctx = buildFlowContext(
            processStateData.processExecutionId,
            processStateData.processStartedAt,
            completedSteps,
          ) as FlowContext<Record<string, StepMeta>>
          const expiresAt = yield* resolveMaybeEffect(
            publicCompletion.expiresAt(
              processStateData.state as Record<string, unknown>,
              ctx,
              todo.itemData ?? undefined,
            ),
          )
          const freshToken = yield* encryptPublicTodoToken({
            v: 1,
            tid: args.todoId,
            externalParticipantEmail: latestInvitation.email,
            publicCompletionInvitationAttemptId: latestInvitation.id,
            iat: Math.floor(
              DateTime.toEpochMillis(context._requestTime) / 1000,
            ),
            exp: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000),
            aud: PUBLIC_TODO_TOKEN_AUDIENCE,
          })
          const frontendOrigin = resolveRegistrationLinkFrontendOrigin()
          if (!frontendOrigin) {
            return yield* new InputValidationError({
              errors: [
                {
                  field: "",
                  message: "FRONTEND_BASE_URL is not configured",
                },
              ],
            })
          }

          return buildPublicTodoUrl(frontendOrigin, freshToken)
        }),

      settingsUserCount: () =>
        Effect.flatMap(SettingsQueries, (queries) => queries.countUsers()),
      settingsRoleCount: () =>
        Effect.flatMap(SettingsQueries, (queries) => queries.countRoles()),
      settingsInvitationCount: () =>
        Effect.flatMap(SettingsQueries, (queries) =>
          queries.countInvitations(),
        ),
      settingsOAuthProviderCount: () =>
        Effect.flatMap(SettingsQueries, (queries) =>
          queries.countOAuthProviders(),
        ),

      allUsers: createPaginatedCollectionResolver(
        (_args: { page: number; limit: number }, pagination) =>
          Effect.gen(function* () {
            const settingsQueries = yield* SettingsQueries
            return yield* settingsQueries.queryAllUsers(
              pagination.page,
              pagination.limit,
            )
          }),
      ),

      allOAuthProviders: createPaginatedCollectionResolver(
        (_args: { page: number; limit: number }, pagination) =>
          Effect.gen(function* () {
            const settingsQueries = yield* SettingsQueries
            return yield* settingsQueries.queryAllOAuthProviders(
              pagination.page,
              pagination.limit,
            )
          }),
      ),

      allInvitations: createPaginatedCollectionResolver(
        (
          args: {
            page: number
            limit: number
            status?: "PENDING" | "ACCEPTED" | "LEGACY_CLOSED" | null
          },
          pagination,
        ) =>
          Effect.gen(function* () {
            const settingsQueries = yield* SettingsQueries
            const result = yield* settingsQueries.queryAllInvitations(
              pagination.page,
              pagination.limit,
              fromGraphQLInvitationStatus(args.status),
            )
            return {
              ...result,
              items: result.items.map(toGraphQLInvitation),
            }
          }),
      ),

      invitationDetail: (_parent: unknown, args: { invitationId: string }) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const invitation = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          return invitation ? toGraphQLInvitation(invitation) : null
        }),

      userDetail: (_parent: unknown, args: { userId: string }) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const userDetail = yield* settingsQueries.queryUserDetail(args.userId)
          return userDetail
        }),

      notificationPreferences: (_parent: unknown, args: { userId: string }) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const preferences =
            yield* settingsQueries.queryNotificationPreferences(args.userId)
          return preferences
        }),

      allRoles: createPaginatedCollectionResolver(
        (_args: { page: number; limit: number }, pagination) =>
          Effect.gen(function* () {
            const settingsQueries = yield* SettingsQueries
            return yield* settingsQueries.queryPaginatedRoles(
              pagination.page,
              pagination.limit,
            )
          }),
      ),

      processStateForExecution: (
        _parent: unknown,
        args: { executionId: string },
      ) =>
        Effect.gen(function* () {
          const executionQueries = yield* ExecutionQueries
          return yield* executionQueries.getProcessStateByExecutionId(
            args.executionId,
          )
        }),

      subscriptionTransport: () =>
        Effect.succeed({
          kind: process.env["APPSYNC_EVENTS_HTTP_HOST"]
            ? "APPSYNC_EVENTS"
            : "GRAPHQL_WS",
          appSyncEventsHttpHost:
            process.env["APPSYNC_EVENTS_HTTP_HOST"] ?? null,
        }),

      listMetadata,

      listCreateFormMetadata: (
        _parent: unknown,
        args: { listPath: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation } = yield* OrganisationProvider
          const list = organisation.listByPath(args.listPath)
          if (!list?.hasCreate) return null
          const auth = yield* AuthorizationService
          const principal = yield* buildPrincipal(context)
          const resource = new ListRef(
            normalizePath(list.node.path),
            rolePathsForList(list.roles),
          )
          const canView = yield* auth.canAccessList(principal, resource)
          const canCreate = yield* auth.canCreateList(principal, resource)
          if (!canView || !canCreate) return null
          return yield* list.createFormMetadata(
            currentProviderUserDefault(context),
          )
        }),

      listFormMetadata: (
        _parent: unknown,
        args: { listPath: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const auth = yield* AuthorizationService

          const allLists = org.lists()
          const list = allLists.find(
            (l) => normalizePath(l.node.path) === normalizePath(args.listPath),
          )

          if (!list) {
            yield* Effect.logWarning("listFormMetadata: list not found", {
              listPath: args.listPath,
            })
            return null
          }

          // Must have a form. Lists without update return read-only metadata.
          if (!list.hasForm) {
            return null
          }

          // Read-only forms require normal list access. Metadata for
          // update-capable lists exposes update operation names, so keep those
          // gated by update permission.
          const principal = yield* buildPrincipal(context)
          const resource = new ListRef(
            normalizePath(list.node.path),
            rolePathsForList(list.roles),
          )
          const canAccess = yield* auth
            .canAccessList(principal, resource)
            .pipe(Effect.orElseSucceed(() => false))

          if (!canAccess) {
            return null
          }

          const canUpdate = yield* auth
            .canUpdateList(principal, resource)
            .pipe(Effect.orElseSucceed(() => false))

          if (list.hasUpdate && !canUpdate) {
            return null
          }

          // Check delete authorization (separate from update)
          const canDelete =
            list.hasDelete &&
            (yield* auth
              .canDeleteList(principal, resource)
              .pipe(Effect.orElseSucceed(() => false)))

          // Schema defaults only (item data is merged on the client)
          const defaultValues = list.formDefaults() ?? {}

          return {
            listPath: args.listPath,
            listName: list.name,
            updateMutationName: list.hasUpdate
              ? list.updateMutationName()
              : null,
            updateInputTypeName: list.hasUpdate
              ? list.updateInputTypeName()
              : null,
            deleteMutationName: canDelete ? list.deleteMutationName() : null,
            defaultValues,
          }
        }),

      availableLists: (
        _parent: unknown,
        _args: unknown,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const auth = yield* AuthorizationService

          const principal = yield* buildPrincipal(context)

          // Get all lists from the organization
          const allLists = org.lists()

          // Filter lists by authorization
          // biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
          const accessibleLists: List<any, any, any, any, any, any>[] = []

          for (const list of allLists) {
            const resource = new ListRef(
              normalizePath(list.node.path),
              rolePathsForList(list.roles),
            )
            const canAccess = yield* auth
              .canAccessList(principal, resource)
              .pipe(Effect.orElseSucceed(() => false))

            if (canAccess) {
              accessibleLists.push(list)
            }
          }

          return yield* Effect.forEach(accessibleLists, (list) =>
            Effect.gen(function* () {
              const canCreate =
                list.hasCreate &&
                (yield* auth
                  .canCreateList(
                    principal,
                    new ListRef(
                      normalizePath(list.node.path),
                      rolePathsForList(list.roles),
                    ),
                  )
                  .pipe(Effect.orElseSucceed(() => false)))
              const startProcesses = list.startProcess
                ? yield* filterAuthorizedProcessRows(context, [
                    list.startProcess,
                  ])
                : []
              return {
                startProcess: startProcesses[0] ?? null,
                additionalStartProcesses: yield* filterAuthorizedProcessRows(
                  context,
                  [...list.additionalStartProcesses],
                ),
                anonymousPage: list.anonymousPage ?? null,
                canCreate,
                id: normalizePath(list.node.path),
                path: normalizePath(list.node.path),
                name: list.name,
                detailName: list.detailName ?? null,
                purpose: list.purpose ?? null,
                queryName: list.queryName(),
                outputColumns: list.outputColumns(),
                itemQueryName: list.hasForm ? list.itemQueryName() : null,
                updateMutationName: list.hasUpdate
                  ? list.updateMutationName()
                  : null,
                updateInputTypeName: list.hasUpdate
                  ? list.updateInputTypeName()
                  : null,
                deleteMutationName: list.hasDelete
                  ? list.deleteMutationName()
                  : null,
                // Note: deleteMutationName is exposed without per-user Cedar check here.
                // This is intentional - the actual delete mutation enforces authorization.
                // Exposing the mutation name allows the UI to know delete is available
                // for the list type, but users still can't execute it without proper auth.
                editableColumns: list.editableFormColumns(),
              }
            }),
          )
        }),

      availableStatsViews: (
        _parent: unknown,
        _args: unknown,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const auth = yield* AuthorizationService

          const principal = yield* buildPrincipal(context)

          const allStatsViews = org.statsViews()

          const accessibleStatsViews: StatsView[] = []

          for (const statsView of allStatsViews) {
            const resource = new ListRef(
              normalizePath(statsView.node.path),
              rolePathsForList(statsView.roles),
            )
            const canAccess = yield* auth
              .canAccessList(principal, resource)
              .pipe(Effect.orElseSucceed(() => false))

            if (canAccess) {
              accessibleStatsViews.push(statsView)
            }
          }

          return accessibleStatsViews.map((statsView) => ({
            id: normalizePath(statsView.node.path),
            path: normalizePath(statsView.node.path),
            name: statsView.name,
            purpose: statsView.purpose ?? null,
            renderer: statsView.renderer,
            queryName: statsView.queryName,
          }))
        }),

      lookupSelection: (
        _parent: unknown,
        args: {
          stepPath: string
          field: string
          value: string
          todoId?: string | null
          listCreate?: boolean | null
        },
        context: UserContext,
        info: GraphQLResolveInfo,
      ) =>
        Effect.gen(function* () {
          const resolve = resolvers.Query?.["lookupSuggestions"]
          if (typeof resolve !== "function") return null
          const result = yield* resolve(
            {},
            { ...args, selectedValue: args.value },
            context,
            info,
          )
          const items = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ value: Schema.String, label: Schema.String }),
            ),
          )(result)
          return items[0] ?? null
        }),

      lookupSearch: (
        _parent: unknown,
        args: {
          stepPath: string
          field: string
          filter?: string | null
          limit?: number | null
          todoId?: string | null
          listCreate?: boolean | null
        },
        context: UserContext,
        info: GraphQLResolveInfo,
      ) =>
        Effect.gen(function* () {
          // Reuse the same step, field, List and Todo authorization boundary.
          // Reserve one slot beneath the endpoint ceiling to detect truncation.
          const limit = Math.max(1, Math.min(args.limit ?? 20, 99))
          const resolve = resolvers.Query?.["lookupSuggestions"]
          if (typeof resolve !== "function")
            return yield* new NotAuthorized({
              action: "lookup",
              resource: args.stepPath,
              message: "Lookup is unavailable",
            })
          const result = yield* resolve(
            {},
            { ...args, limit: limit + 1 },
            context,
            info,
          )
          const items = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ value: Schema.String, label: Schema.String }),
            ),
          )(result)
          return { items: items.slice(0, limit), hasMore: items.length > limit }
        }),

      lookupSuggestions: (
        _parent: unknown,
        args: {
          stepPath: string
          field: string
          filter?: string | null
          limit?: number | null
          todoId?: string | null
          listCreate?: boolean | null
          selectedValue?: string
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const filter = args.filter ?? ""
          const selection = args.selectedValue
          const lookupLimit = (
            field: Schema.Struct.Fields[string] | undefined,
          ) => {
            const annotation = field
              ? getSchemaAnnotationDeep(field, FormLookupInput)
              : Option.none()
            const metadata = Option.getOrUndefined(annotation)
            if (
              typeof metadata === "object" &&
              metadata !== null &&
              "mode" in metadata &&
              metadata.mode === "local" &&
              "maxItems" in metadata &&
              typeof metadata.maxItems === "number"
            )
              return metadata.maxItems + 1
            return Math.max(0, Math.min(args.limit ?? 20, 100))
          }

          const listCreate = args.listCreate === true
          // An explicit List create request cannot resolve to a process form.
          const form = listCreate ? undefined : org.formByPath(args.stepPath)
          if (form) {
            yield* checkStepAuthorization(context, args.stepPath)
            const fieldSchema = getSubmissionFields(form.output)[args.field]
            const limit = lookupLimit(fieldSchema)
            const permission = fieldSchema
              ? getSchemaAnnotationDeep(
                  fieldSchema as Schema.Top,
                  FormPermission,
                )
              : Option.none()
            if (
              fieldSchema &&
              Option.isSome(permission) &&
              isFieldPermissionMetadata(permission.value)
            ) {
              const step = org.stepByPath(args.stepPath)
              const stepRoleQueries = yield* StepRoleQueries
              const stepRoleInfo =
                yield* stepRoleQueries.queryRolePathsByStepPath(args.stepPath)
              const allowed = step
                ? yield* canModifyField(context, {
                    stepPath: args.stepPath,
                    fieldName: args.field,
                    rolePath: normalizePath(permission.value.modify.node.path),
                    stepRolePath: stepRoleInfo.rolePath,
                    processPath: step.process.node.path,
                    orgUnitId: step.process.orgUnit.node.path,
                    stepStartsProcess: stepRoleInfo.startsProcess,
                    stepEmbedded: stepRoleInfo.embedded,
                  }).pipe(
                    Effect.tapError((error) =>
                      Effect.logWarning("Lookup field authorization failed", {
                        error,
                        fieldName: args.field,
                        stepPath: args.stepPath,
                      }),
                    ),
                    Effect.catch(() => Effect.succeed(false)),
                  )
                : false
              if (!allowed) {
                return yield* new NotAuthorized({
                  action: "lookup",
                  resource: args.field,
                  message: `Lookup field ${args.field} is not authorized`,
                })
              }
            }
            if (
              fieldSchema &&
              hasProviderUserInput(fieldSchema as Schema.Top)
            ) {
              if (selection !== undefined) return []
              return yield* providerUserLookupSuggestions(
                context,
                filter,
                limit,
              )
            }

            if (
              selection !== undefined &&
              !args.todoId &&
              !form.process
                .startNodes()
                .some((node) => node.node.path === form.node.path)
            ) {
              return yield* new NotAuthorized({
                action: "lookup",
                resource: args.stepPath,
                message: "Lookup selection requires a Todo",
              })
            }
            if (
              args.todoId &&
              (selection !== undefined ||
                !form.lookupOverrides().has(args.field))
            ) {
              const stepCompletionOps = yield* StepCompletionOperations
              if (selection !== undefined) {
                const todo = yield* stepCompletionOps.queryTodoById(args.todoId)
                if (
                  !todo ||
                  normalizePath(todo.targetStepPath) !==
                    normalizePath(args.stepPath)
                )
                  return yield* new NotAuthorized({
                    action: "lookup",
                    resource: args.stepPath,
                    message: "Lookup Todo does not match this form",
                  })
                yield* checkTodoAuthorization(context, todo)
              }
              const processStateData =
                yield* stepCompletionOps.getProcessStateByTodoId(args.todoId)

              if (!processStateData) {
                return yield* new ProcessStateNotFound({
                  todoId: args.todoId,
                  stepPath: args.stepPath,
                  message: `Process state not found for todo "${args.todoId}"`,
                })
              }

              const completedSteps =
                yield* stepCompletionOps.getCompletedStepsForExecution(
                  processStateData.processExecutionId,
                )
              const ctx = buildFlowContext(
                processStateData.processExecutionId,
                processStateData.processStartedAt,
                completedSteps,
              )
              const todoInfo = yield* stepCompletionOps.queryTodoById(
                args.todoId,
              )
              if (
                !todoInfo ||
                normalizePath(todoInfo.targetStepPath) !==
                  normalizePath(args.stepPath) ||
                todoInfo.processExecutionId !==
                  processStateData.processExecutionId
              ) {
                return yield* new NotAuthorized({
                  action: "lookup",
                  resource: args.field,
                  message: `Lookup todo ${args.todoId} is not authorized for step ${args.stepPath}`,
                })
              }

              // GraphQL widens org forms, but this call needs the hydrated
              // process state type to re-run state-backed lookup closures.
              const statefulForm = form as Form<
                Record<string, unknown>,
                Record<string, StepMeta>,
                Schema.Struct.Fields,
                string,
                unknown
              >

              if (selection !== undefined) {
                const item = yield* statefulForm.resolveLookupSelection(
                  args.field,
                  selection,
                  statefulForm.getFieldsWithState(
                    processStateData.state,
                    ctx as FlowContext<Record<string, StepMeta>>,
                    todoInfo.itemData ?? undefined,
                  ),
                )
                return item ? [item] : []
              }

              return yield* statefulForm.executeLookupWithState(
                args.field,
                filter,
                limit,
                processStateData.state,
                ctx as FlowContext<Record<string, StepMeta>>,
                todoInfo.itemData ?? undefined,
              )
            }

            if (selection !== undefined) {
              const item = yield* form.resolveLookupSelection(
                args.field,
                selection,
                form.getFieldsWithState({}, startFormContext(context)),
              )
              return item ? [item] : []
            }
            if (
              !form.process
                .startNodes()
                .some((node) => node.node.path === form.node.path)
            ) {
              return yield* form.executeLookup(args.field, filter, limit)
            }
            return yield* form.executeLookupWithState(
              args.field,
              filter,
              limit,
              {},
              startFormContext(context),
            )
          }

          // List form lookups pass the list path as stepPath.
          const list = org.listByPath(args.stepPath)
          if (list && (listCreate ? list.hasCreate : list.hasForm)) {
            const listPath = normalizePath(list.node.path)
            const rolePaths = rolePathsForList(list.roles)

            if (listCreate) {
              yield* checkListAuthorization(context, listPath, rolePaths)
              yield* checkListCreateAuthorization(context, listPath, rolePaths)
            } else {
              yield* checkListUpdateAuthorization(context, listPath, rolePaths)
            }

            const fields = listCreate
              ? (list.createFormFields ?? {})
              : list.editableFormFields()
            const fieldSchema = getSubmissionFields(fields)[args.field]
            const limit = lookupLimit(fieldSchema)
            if (!fieldSchema) {
              return yield* new LookupFieldNotFoundError({
                fieldName: args.field,
                formStep: listPath,
                message: `Lookup field "${args.field}" not found in list form "${listPath}"`,
              })
            }

            const permission = getSchemaAnnotationDeep(
              fieldSchema as Schema.Top,
              FormPermission,
            )
            if (
              Option.isSome(permission) &&
              isFieldPermissionMetadata(permission.value)
            ) {
              const allowed = yield* canModifyListFieldForAnyRole(context, {
                listPath,
                fieldName: args.field,
                rolePath: normalizePath(permission.value.modify.node.path),
                listRolePaths: rolePaths,
                orgUnitId: list.orgUnit.node.path,
                logMessage: "List lookup field authorization failed",
              })

              if (!allowed) {
                return yield* new NotAuthorized({
                  action: "lookup",
                  resource: args.field,
                  message: `Lookup field ${args.field} is not authorized`,
                })
              }
            }

            if (
              fieldSchema &&
              hasProviderUserInput(fieldSchema as Schema.Top)
            ) {
              if (selection !== undefined) return []
              return yield* providerUserLookupSuggestions(
                context,
                filter,
                limit,
              )
            }

            const metadata = getSchemaAnnotationDeep(
              fieldSchema as Schema.Top,
              FormLookupInput,
            ).pipe(Option.getOrUndefined) as LookupFieldMetadata | undefined

            if (selection !== undefined) {
              const item = metadata?.resolve
                ? yield* metadata.resolve(selection)
                : null
              return item?.value === selection ? [item] : []
            }

            if (!metadata?.query) {
              return yield* new LookupFieldNotFoundError({
                fieldName: args.field,
                formStep: listPath,
                message: `Field "${args.field}" in list form "${listPath}" is not a lookup field (no query defined)`,
              })
            }

            return yield* metadata.query(filter, limit)
          }

          yield* Effect.logWarning(
            "lookupSuggestions: path not found or has no lookup-capable form",
            { stepPath: args.stepPath },
          )
          return yield* new NotAuthorized({
            action: "lookup",
            resource: args.stepPath,
            message: `Path ${args.stepPath} not found or has no form lookups`,
          })
        }),

      calendarSlots: (
        _parent: unknown,
        args: {
          stepPath: string
          field: string
          todoId?: string | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const form = org.formByPath(args.stepPath)
          if (!form) {
            yield* Effect.logWarning("calendarSlots: form path not found", {
              stepPath: args.stepPath,
            })
            return yield* new NotAuthorized({
              action: "calendarSlots",
              resource: args.stepPath,
              message: `Path ${args.stepPath} not found or has no form calendar slots`,
            })
          }

          yield* checkStepAuthorization(context, args.stepPath)

          const fieldSchema = getSubmissionFields(form.output)[args.field]
          if (!fieldSchema) {
            return yield* new LookupFieldNotFoundError({
              fieldName: args.field,
              formStep: args.stepPath,
              message: `Calendar slot field "${args.field}" not found in form "${args.stepPath}"`,
            })
          }

          const permission = getSchemaAnnotationDeep(
            fieldSchema as Schema.Top,
            FormPermission,
          )
          if (
            Option.isSome(permission) &&
            isFieldPermissionMetadata(permission.value)
          ) {
            const step = org.stepByPath(args.stepPath)
            const stepRoleQueries = yield* StepRoleQueries
            const stepRoleInfo =
              yield* stepRoleQueries.queryRolePathsByStepPath(args.stepPath)
            const allowed = step
              ? yield* canModifyField(context, {
                  stepPath: args.stepPath,
                  fieldName: args.field,
                  rolePath: normalizePath(permission.value.modify.node.path),
                  stepRolePath: stepRoleInfo.rolePath,
                  processPath: step.process.node.path,
                  orgUnitId: step.process.orgUnit.node.path,
                  stepStartsProcess: stepRoleInfo.startsProcess,
                  stepEmbedded: stepRoleInfo.embedded,
                }).pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning(
                      "Calendar slot field authorization failed",
                      {
                        error,
                        fieldName: args.field,
                        stepPath: args.stepPath,
                      },
                    ),
                  ),
                  Effect.catch(() => Effect.succeed(false)),
                )
              : false
            if (!allowed) {
              return yield* new NotAuthorized({
                action: "calendarSlots",
                resource: args.field,
                message: `Calendar slot field ${args.field} is not authorized`,
              })
            }
          }

          if (args.todoId) {
            const executionContext = yield* loadTodoFormExecutionContext({
              todoId: args.todoId,
              stepPath: args.stepPath,
              field: args.field,
              action: "calendarSlots",
              unauthorizedMessage: `Calendar slot todo ${args.todoId} is not authorized for step ${args.stepPath}`,
            })

            const statefulForm = form as Form<
              Record<string, unknown>,
              Record<string, StepMeta>,
              Schema.Struct.Fields,
              string,
              unknown
            >

            return yield* statefulForm.executeCalendarSlotsWithState(
              args.field,
              executionContext.state,
              executionContext.ctx,
              executionContext.itemData,
            )
          }

          if (
            !form.process
              .startNodes()
              .some((node) => node.node.path === form.node.path)
          ) {
            return yield* form.executeCalendarSlots(args.field)
          }
          return yield* form.executeCalendarSlotsWithState(
            args.field,
            {},
            startFormContext(context),
          )
        }),

      requestDownloadUrl: (
        _parent: unknown,
        args: { stepPath: string; documentStore: string; fileId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          yield* rejectUnsupportedDelegationHandoff(
            context.jwt?.properties,
            "file download",
          )
          const fileOps = yield* FileOperations
          const docStoreService = yield* DocumentStoreService

          // Check user can complete this step
          yield* checkStepAuthorization(context, args.stepPath)

          // Verify step references this document store
          const linked = yield* fileOps.isStepLinkedToDocumentStore(
            args.stepPath,
            args.documentStore,
          )
          if (!linked) {
            return yield* new NotAuthorized({
              action: "download",
              resource: args.documentStore,
              message: `Step ${args.stepPath} does not reference document store ${args.documentStore}`,
            })
          }

          // Look up document store by path
          const store = yield* fileOps.getDocumentStoreByPath(
            args.documentStore,
          )
          if (!store) {
            return yield* new DocumentStoreNotFoundError({
              path: args.documentStore,
            })
          }

          // Look up file owner and org unit for authorization
          const fileInfo = yield* fileOps.getFileOwnerInfo(args.fileId)
          if (!fileInfo) {
            return yield* new FileNotFoundError({
              fileId: args.fileId,
            })
          }

          // Check file-level Cedar authorization
          const principal = yield* buildPrincipal(context)
          const auth = yield* AuthorizationService
          const fileResource = new FileRef(
            args.fileId,
            fileInfo.createdBy,
            fileInfo.orgUnitPath,
            fileInfo.documentStorePath,
          )
          const canDownload = yield* auth.canDownloadFile(
            principal,
            fileResource,
          )
          if (!canDownload) {
            return yield* new NotAuthorized({
              action: "download",
              resource: args.fileId,
              message: `User ${principal.uid.id} is not authorized to download file ${args.fileId}`,
            })
          }

          return yield* docStoreService.requestDownloadUrl(
            args.fileId,
            store.name,
          )
        }),

      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
    OrgUnit: {
      subunits: (parent: ResolversParentTypes["OrgUnit"]) =>
        orgQueries
          .queryChildren(parent.id)
          .pipe(Effect.map((units) => units.map(mapOrgUnit))),
      processes: (parent: ResolversParentTypes["OrgUnit"]) =>
        orgQueries.queryProcesses(parent.id).pipe(
          Effect.map((processes) =>
            processes.map((process) => {
              return {
                ...process,
                activeInstances: 3,
                category: "test",
                duration: "",
                formFieldCount: 0,
                isFavorite: false,
                orgUnit: parent, // Use the parent orgUnit since these processes belong to it
              }
            }),
          ),
        ),
      roles: (parent: ResolversParentTypes["OrgUnit"]) =>
        orgQueries.queryRoles(parent.id),
      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
    ProviderUser: {
      permittedRoles: (
        parent: ResolversParentTypes["ProviderUser"],
        _args: unknown,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const db = yield* ProviderUserQueries

          const principal = yield* buildProviderUserRoleSwitchPrincipal(
            parent,
            context,
          )

          const allRoles = yield* db.queryAllRoles()

          // Filter by Cedar permission (read-only - no database writes)
          const permitted: RoleRow[] = []
          for (const role of allRoles) {
            // Do not advertise unsupported temporary grants to delegates.
            if (
              hasDelegation(context.jwt?.properties) &&
              !principal.roles.some(
                (assignedRole) => assignedRole.id === role.path,
              )
            )
              continue
            const canSwitch = yield* auth.canRequestRole(
              principal,
              new RoleRef(role.path),
            )
            if (canSwitch) permitted.push(role)
          }

          // If only one role is available, there is nothing useful to switch to.
          // Otherwise return every permitted role, including the active role, so
          // the user can switch back after entering a narrow role context.
          if (permitted.length <= 1) {
            return []
          }

          return permitted.map((r) => ({
            id: r.id,
            name: r.name,
            path: r.path,
          }))
        }),
      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
    Mutation: {
      completeTodoFromChat: (
        _parent: unknown,
        args: { todoId: string; answers: unknown },
        context: UserContext,
      ) =>
        decodeTodoChatAnswers(args.answers).pipe(
          Effect.flatMap((input) =>
            completeTodoFromChat({
              todoId: args.todoId,
              input,
              identity: executionIdentity(context),
            }),
          ),
        ),
      startDeploymentProbe: (
        _parent: unknown,
        args: { input: unknown },
        context: UserContext,
      ) => resolveDeploymentProbe("start", args.input, context),
      submitAnonymousPage: (
        _parent: unknown,
        args: { address: string; input: Record<string, unknown> },
        context: UserContext,
      ) => submitAnonymousPage(args, context).pipe(Effect.as(true)),
      completePublicTodo: (
        _parent: unknown,
        args: { token: string; input?: Record<string, unknown> | null },
        context: UserContext,
      ) => completePublicTodo(args.token, args.input ?? {}, context),
      requestFreshPublicTodoLink: (
        _parent: unknown,
        args: { token: string },
        context: UserContext,
      ) => requestFreshPublicTodoLink(args.token, context),
      submitPublicCompletionCorrection: (
        _parent: unknown,
        args: { todoId: string; correctedEmail: string },
        context: UserContext,
      ) =>
        submitPublicCompletionCorrection(
          args.todoId,
          args.correctedEmail,
          context,
        ),

      exportListCsv: (
        _parent: unknown,
        args: {
          listPath: string
          filter?: string | null
          sort?: { field: string; direction: "ASC" | "DESC" } | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const listExportService = yield* ListExportService
          return yield* listExportService.exportListCsv(
            args.listPath,
            context,
            { filter: args.filter ?? null, sort: args.sort ?? null },
          )
        }),
      cleanupExecutions: () =>
        Effect.gen(function* () {
          const cleanupOps = yield* CleanupOperations
          const sql = yield* SqlClient.SqlClient
          return yield* sql
            .withTransaction(cleanupOps.cleanupExecutions())
            .pipe(
              Effect.retry({
                schedule: SQLITE_BUSY_RETRY_SCHEDULE,
                while: isSqliteBusy,
              }),
            )
        }),
      requestRole: (
        _parent: unknown,
        args: { rolePath: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const providerUserDb = yield* ProviderUserQueries
          const oauthClientDb = yield* OAuthClientQueries

          // Determine if this is an M2M (service account) or provider user request
          const props = context.jwt?.properties
          const m2mProps = isServiceAccountSession(props) ? props : null
          const preparationVersion =
            isProviderUserSession(props) && !props.delegation
              ? yield* providerUserAuthorityVersion(props.userId)
              : undefined

          if (!context.userId) {
            return {
              success: false,
              rolePath: null,
              error: "Not authenticated",
            }
          }
          const userId = context.userId

          const roleOption = yield* providerUserDb.queryRoleByPath(
            args.rolePath,
          )
          if (Option.isNone(roleOption)) {
            return {
              success: false,
              rolePath: null,
              error: `Role not found: ${args.rolePath}`,
            }
          }
          const role = roleOption.value

          // Build principal based on session type. Provider-user role switching
          // is authorized from account-level assigned roles, not the active
          // role-limited JWT, so switching into a narrow role does not trap the
          // user there.
          const { principal, providerUser } = m2mProps
            ? {
                principal: new ServiceAccountPrincipal(
                  m2mProps.clientId,
                  m2mProps.roles ?? [],
                ),
                providerUser: null,
              }
            : yield* Effect.gen(function* () {
                const providerUserOption =
                  yield* providerUserDb.queryProviderUserByUserId(userId)
                if (Option.isNone(providerUserOption)) {
                  return {
                    principal: null,
                    providerUser: null,
                  }
                }

                return {
                  principal: yield* buildProviderUserRoleSwitchPrincipal(
                    providerUserOption.value,
                    context,
                  ),
                  providerUser: providerUserOption.value,
                }
              })

          if (!principal) {
            return {
              success: false,
              rolePath: null,
              error: "Provider user not found",
            }
          }

          const canRequest = yield* auth
            .canRequestRole(principal, new RoleRef(args.rolePath))
            .pipe(
              Effect.catchTag("AuthorizationError", (e) =>
                Effect.fail(
                  new NotAuthorized({
                    action: "requestRole",
                    resource: args.rolePath,
                    message: e.message,
                  }),
                ),
              ),
            )

          if (!canRequest) {
            yield* Effect.logWarning("Role request denied by Cedar").pipe(
              Effect.annotateLogs({
                userId: context.userId,
                rolePath: args.rolePath,
                isM2M: m2mProps !== null,
              }),
            )
            return {
              success: false,
              rolePath: null,
              error: `Not authorized to request role: ${args.rolePath}`,
            }
          }

          if (hasDelegation(props)) {
            // Switching is supported only within live owner assignments. A
            // Cedar permit cannot turn this into a human temporary-role grant.
            const assigned =
              !m2mProps &&
              providerUser !== null &&
              principal.roles.some(
                (assignedRole) => assignedRole.id === args.rolePath,
              )
            return {
              success: assigned,
              rolePath: assigned ? args.rolePath : null,
              error: assigned
                ? null
                : "Delegated switching to unassigned roles is not supported",
            }
          }

          if (m2mProps) {
            // M2M/ServiceAccount: write to permitted_client_role table
            const clientOption =
              yield* oauthClientDb.queryOAuthClientByClientId(m2mProps.clientId)
            if (Option.isNone(clientOption)) {
              return {
                success: false,
                rolePath: null,
                error: "OAuth client not found",
              }
            }
            const client = clientOption.value

            // This is a single upsert statement, so retry lock contention
            // directly instead of starting a separate transaction.
            yield* oauthClientDb
              .addPermittedClientRole(client.id, role.id)
              .pipe(Effect.retry(SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE))

            yield* Effect.log(
              "Role request authorized for service account",
            ).pipe(
              Effect.annotateLogs({
                clientId: m2mProps.clientId,
                rolePath: args.rolePath,
              }),
            )
          } else {
            if (!providerUser) {
              return {
                success: false,
                rolePath: null,
                error: "Provider user not found",
              }
            }

            if (!isProviderUserSession(props) || !preparationVersion) {
              return {
                success: false,
                rolePath: null,
                error: "A new login is required",
              }
            }
            yield* prepareRoleSwitch(
              props,
              args.rolePath,
              preparationVersion,
            ).pipe(
              Effect.retry({
                schedule: SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE,
                while: (error) => isSqlLockError(error) || isSqliteBusy(error),
              }),
              Effect.annotateLogs({
                userId,
                rolePath: args.rolePath,
                orgUnitId: props.orgUnitId,
                orgUnitPath: props.orgUnitPath,
              }),
            )

            yield* Effect.log("Role request authorized for provider user").pipe(
              Effect.annotateLogs({
                userId: context.userId,
                rolePath: args.rolePath,
              }),
            )
          }

          return {
            success: true,
            rolePath: args.rolePath,
            error: null,
          }
        }),

      createInvitation: (
        _parent: unknown,
        args: {
          registrationLink?: boolean
          input: {
            email: string
            roleIds: readonly string[]
          }
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const sql = yield* SqlClient.SqlClient
          const updatedBy = context._userDetails.by

          // Both Dashboard operations currently require administerUsers. Check
          // issuance explicitly so the combined operation retains that gate.
          if (args.registrationLink) {
            const auth = yield* AuthorizationService
            const principal = yield* buildPrincipal(context)
            if (
              !(yield* auth.canAccessFeature(
                principal,
                new Application("default"),
                "administerUsers",
              ))
            ) {
              return {
                __typename: "SaveInvitationFailure" as const,
                error: "Not authorized to issue Registration Links",
              }
            }
          }

          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const validation = yield* validateInvitationMutationInput(
                  settingsQueries,
                  args.input,
                )
                if (!validation.success) {
                  return yield* new InvitationCreationFailed({
                    message: validation.error,
                  })
                }
                const createdInvitationId =
                  yield* settingsQueries.createInvitation({
                    invitationId: randomUUID(),
                    email: validation.normalizedEmail,
                    source: InvitationSource.Dashboard,
                    createdBy: updatedBy,
                    updatedBy,
                  })

                yield* settingsQueries.replaceInvitationRoles(
                  createdInvitationId,
                  args.input.roleIds,
                  updatedBy,
                )

                const invitation =
                  yield* settingsQueries.queryInvitationDetail(
                    createdInvitationId,
                  )
                if (!invitation) {
                  return yield* new InvitationCreationFailed({
                    message: INVITATION_NOT_FOUND_MESSAGE,
                  })
                }
                if (args.registrationLink) {
                  const result = yield* issueRegistrationLink(
                    yield* SettingsQueries,
                    {
                      invitation,
                      rotate: false,
                      actor: updatedBy,
                      organisationScope:
                        resolveRegistrationLinkOrganisationScope(),
                      frontendOrigin:
                        resolveRegistrationLinkFrontendOrigin() ?? "",
                    },
                  )
                  // A value-level issuance failure must roll back creation too.
                  if (!result.ok)
                    return yield* new InvitationCreationFailed({
                      message: result.error,
                    })
                  return {
                    __typename: "SaveInvitationSuccess" as const,
                    invitation: toGraphQLInvitation(result.invitation),
                    registrationLinkUrl: result.registrationLinkUrl,
                    expiresAt: result.expiresAt,
                  }
                }
                return {
                  __typename: "SaveInvitationSuccess" as const,
                  invitation: toGraphQLInvitation(invitation),
                }
              }),
            )
            .pipe(
              Effect.provideService(immediateTransactionRequested, true),
              Effect.catchTag("InvitationCreationFailed", (error) =>
                Effect.succeed({
                  __typename: "SaveInvitationFailure" as const,
                  error: error.message,
                }),
              ),
              Effect.catchTag("SqlError", () =>
                Effect.succeed({
                  __typename: "SaveInvitationFailure" as const,
                  error:
                    "Could not create Invitation. Check for an existing pending Invitation before retrying; if none exists, contact your administrator.",
                }),
              ),
            )
        }),

      updateInvitation: (
        _parent: unknown,
        args: {
          invitationId: string
          input: {
            email: string
            roleIds: readonly string[]
          }
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const sql = yield* SqlClient.SqlClient
          const updatedBy = context._userDetails.by

          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }
          if (existing.status !== InvitationLifecycleStatus.Pending) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          const validation = yield* validateInvitationMutationInput(
            settingsQueries,
            args.input,
            args.invitationId,
          )
          if (!validation.success) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: validation.error,
            }
          }

          const updateSucceeded = yield* sql.withTransaction(
            Effect.gen(function* () {
              const invitationExists =
                yield* settingsQueries.updateInvitationDetails(
                  args.invitationId,
                  {
                    email: validation.normalizedEmail,
                    updatedBy,
                  },
                )

              if (!invitationExists) {
                return false
              }

              yield* settingsQueries.replaceInvitationRoles(
                args.invitationId,
                args.input.roleIds,
                updatedBy,
              )

              return true
            }),
          )

          if (!updateSucceeded) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          const invitation = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!invitation) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }

          return {
            __typename: "SaveInvitationSuccess" as const,
            invitation: toGraphQLInvitation(invitation),
          }
        }),

      deleteInvitation: (
        _parent: unknown,
        args: { invitationId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const sql = yield* SqlClient.SqlClient
          const updatedBy = context._userDetails.by

          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              success: false,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }
          if (existing.status !== InvitationLifecycleStatus.Pending) {
            return {
              success: false,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          const deleted = yield* sql.withTransaction(
            settingsQueries.deleteInvitation(args.invitationId, updatedBy),
          )

          if (!deleted) {
            return {
              success: false,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          return {
            success: true,
            error: null,
          }
        }),

      generateRegistrationLink: (
        _parent: unknown,
        args: { invitationId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }

          const frontendOrigin = resolveRegistrationLinkFrontendOrigin()
          const result = yield* issueRegistrationLink(yield* SettingsQueries, {
            invitation: existing,
            rotate: false,
            actor: context._userDetails.by,
            organisationScope: resolveRegistrationLinkOrganisationScope(),
            frontendOrigin: frontendOrigin ?? "",
          })
          if (!result.ok) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: result.error,
            }
          }

          return {
            __typename: "RegistrationLinkActionSuccess" as const,
            invitation: toGraphQLInvitation(result.invitation),
            registrationLinkUrl: result.registrationLinkUrl,
            expiresAt: result.expiresAt,
          }
        }),

      revealRegistrationLink: (
        _parent: unknown,
        args: { invitationId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const actor = context._userDetails.by

          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }
          if (existing.status !== InvitationLifecycleStatus.Pending) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          const now = yield* DateTime.now
          const live = yield* settingsQueries.queryLiveRegistrationLink(
            args.invitationId,
            DateTime.toDateUtc(now),
          )
          if (!live) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: NO_ACTIVE_REGISTRATION_LINK_MESSAGE,
            }
          }

          const frontendOrigin = resolveRegistrationLinkFrontendOrigin()
          if (!frontendOrigin) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: TRUSTED_FRONTEND_ORIGIN_NOT_CONFIGURED_MESSAGE,
            }
          }

          const rawToken = yield* decryptRegistrationLinkToken({
            organisationScope: resolveRegistrationLinkOrganisationScope(),
            invitationId: live.invitationId,
            tokenHash: live.tokenHash,
            // Seal/open use whole-second expiry to survive julianday round-trips.
            // Round (not floor) so small negative float drift still maps to the
            // same sealed second.
            expiresAtUnixMs: Math.round(live.expiresAt.getTime() / 1000) * 1000,
            envelope: {
              encryptionVersion: live.encryptionVersion,
              nonce: live.nonce,
              authenticationTag: live.authenticationTag,
              ciphertext: live.ciphertext,
            },
          })

          const recorded = yield* settingsQueries.recordRegistrationLinkReveal(
            args.invitationId,
            actor,
            {
              tokenHash: live.tokenHash,
              generation: live.generation,
            },
          )
          if (!recorded) {
            // Concurrent rotate/generate replaced the pin; do not return the
            // now-invalid decrypted bearer URL.
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: REGISTRATION_LINK_CONFLICT_MESSAGE,
            }
          }

          const invitation = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!invitation) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }

          return {
            __typename: "RegistrationLinkActionSuccess" as const,
            invitation: toGraphQLInvitation(invitation),
            registrationLinkUrl: buildRegistrationLinkUrl(
              frontendOrigin,
              rawToken,
            ),
            expiresAt: live.expiresAt,
          }
        }).pipe(
          Effect.catchTag("RegistrationLinkCryptoError", (error) =>
            Effect.succeed({
              __typename: "RegistrationLinkActionFailure" as const,
              error: mapRegistrationLinkCryptoError(error),
            }),
          ),
        ),

      rotateRegistrationLink: (
        _parent: unknown,
        args: { invitationId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }

          const frontendOrigin = resolveRegistrationLinkFrontendOrigin()
          const result = yield* issueRegistrationLink(yield* SettingsQueries, {
            invitation: existing,
            rotate: true,
            actor: context._userDetails.by,
            organisationScope: resolveRegistrationLinkOrganisationScope(),
            frontendOrigin: frontendOrigin ?? "",
          })
          if (!result.ok) {
            return {
              __typename: "RegistrationLinkActionFailure" as const,
              error: result.error,
            }
          }

          return {
            __typename: "RegistrationLinkActionSuccess" as const,
            invitation: toGraphQLInvitation(result.invitation),
            registrationLinkUrl: result.registrationLinkUrl,
            expiresAt: result.expiresAt,
          }
        }),

      revokeRegistrationLink: (
        _parent: unknown,
        args: { invitationId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const actor = context._userDetails.by

          const existing = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!existing) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }
          if (existing.status !== InvitationLifecycleStatus.Pending) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: IMMUTABLE_INVITATION_MESSAGE,
            }
          }

          const revoked = yield* settingsQueries.revokeRegistrationLink(
            args.invitationId,
            actor,
          )
          if (!revoked) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: noLiveRegistrationLinkToRevokeMessage,
            }
          }

          const invitation = yield* settingsQueries.queryInvitationDetail(
            args.invitationId,
          )
          if (!invitation) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: INVITATION_NOT_FOUND_MESSAGE,
            }
          }

          return {
            __typename: "SaveInvitationSuccess" as const,
            invitation: toGraphQLInvitation(invitation),
          }
        }),

      updateProviderUser: (
        _parent: unknown,
        args: {
          providerUserId: string
          input: {
            roleIds: readonly string[]
            firstName?: string | null
            lastName?: string | null
          }
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const sql = yield* SqlClient.SqlClient

          // Check if provider user exists
          const providerUser = yield* settingsQueries.queryProviderUserDetail(
            args.providerUserId,
          )
          if (!providerUser) {
            return {
              __typename: "UpdateProviderUserFailure" as const,
              error: "Provider user not found",
            }
          }

          const changesNames =
            args.input.firstName != null || args.input.lastName != null
          if (changesNames && providerUser.provider !== "passkey") {
            return {
              __typename: "UpdateProviderUserFailure" as const,
              error:
                "Names for this user are managed by the external identity provider.",
            }
          }

          const firstName =
            args.input.firstName?.trim() ?? providerUser.firstName
          const lastName = args.input.lastName?.trim() ?? providerUser.lastName
          if (
            changesNames &&
            (firstName.length > 128 || lastName.length > 128)
          ) {
            return {
              __typename: "UpdateProviderUserFailure" as const,
              error:
                "First and last names must each be at most 128 characters.",
            }
          }

          // Validate that all roleIds reference existing roles
          const allRoles = yield* settingsQueries.queryAllRoles()
          const validRoleIds = new Set(allRoles.map((r) => r.id))
          const invalidRoleIds = args.input.roleIds.filter(
            (id) => !validRoleIds.has(id),
          )
          if (invalidRoleIds.length > 0) {
            return {
              __typename: "UpdateProviderUserFailure" as const,
              error: `Invalid role IDs: ${invalidRoleIds.join(", ")}`,
            }
          }

          // Wrap in transaction for atomicity
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (changesNames) {
                yield* settingsQueries.updateProviderUserNames(
                  args.providerUserId,
                  {
                    firstName,
                    lastName,
                    name:
                      [firstName, lastName].filter(Boolean).join(" ") ||
                      providerUser.email,
                  },
                  context._userDetails.by,
                )
              }
              yield* settingsQueries.replaceProviderUserRoles(
                args.providerUserId,
                args.input.roleIds,
              )
            }),
          )

          const updated = yield* settingsQueries.queryProviderUserDetail(
            args.providerUserId,
          )

          // This should never happen since we just updated successfully
          if (!updated) {
            return {
              __typename: "UpdateProviderUserFailure" as const,
              error: "Failed to fetch updated provider user",
            }
          }

          return {
            __typename: "UpdateProviderUserSuccess" as const,
            providerUser: updated,
          }
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("updateProviderUser: database operation failed", {
              providerUserId: args.providerUserId,
              error,
            }),
          ),
          Effect.catchTag("SqlError", () =>
            Effect.succeed({
              __typename: "UpdateProviderUserFailure" as const,
              error: "Failed to update user. Please try again.",
            }),
          ),
        ),

      updateNotificationPreferences: (
        _parent: unknown,
        args: {
          userId: string
          preferences: {
            notifications: {
              todoAssignment?: { email: boolean } | null
              executionFailure?: { email: boolean } | null
            }
          }
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const settingsQueries = yield* SettingsQueries
          const currentPreferences =
            yield* settingsQueries.queryNotificationPreferences(args.userId)

          const preferences = {
            notifications: {
              todoAssignment: {
                email:
                  args.preferences.notifications.todoAssignment?.email ??
                  currentPreferences.notifications.todoAssignment.email,
              },
              executionFailure: {
                email:
                  args.preferences.notifications.executionFailure?.email ??
                  currentPreferences.notifications.executionFailure.email,
              },
            },
          }

          yield* settingsQueries.updateNotificationPreferences(
            args.userId,
            preferences,
            context._userDetails.by,
          )

          return {
            __typename: "UpdateNotificationPreferencesSuccess" as const,
            preferences,
          }
        }).pipe(
          Effect.catchTag("SqlError", () =>
            Effect.succeed({
              __typename: "UpdateNotificationPreferencesFailure" as const,
              error: "Failed to update notification preferences",
            }),
          ),
        ),

      restartExecution: (
        _parent: unknown,
        args: { executionId: string },
        context: UserContext,
      ) => restartExecution({ ...args, identity: executionIdentity(context) }),
      abandonExecution: (
        _parent: unknown,
        args: { executionId: string; reason?: string | null },
        context: UserContext,
      ) => abandonExecution({ ...args, identity: executionIdentity(context) }),
      requestUploadUrl: (
        _parent: unknown,
        args: {
          stepPath: string
          documentStore: string
          contentType?: string | null
          filename?: string | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          yield* rejectUnsupportedDelegationHandoff(
            context.jwt?.properties,
            "file upload",
          )
          const fileOps = yield* FileOperations
          const docStoreService = yield* DocumentStoreService

          // Check user can complete this step
          yield* checkStepAuthorization(context, args.stepPath)

          // Verify step references this document store
          const linked = yield* fileOps.isStepLinkedToDocumentStore(
            args.stepPath,
            args.documentStore,
          )
          if (!linked) {
            return yield* new NotAuthorized({
              action: "upload",
              resource: args.documentStore,
              message: `Step ${args.stepPath} does not reference document store ${args.documentStore}`,
            })
          }

          // Look up document store by path
          const store = yield* fileOps.getDocumentStoreByPath(
            args.documentStore,
          )
          if (!store) {
            return yield* new DocumentStoreNotFoundError({
              path: args.documentStore,
            })
          }

          // Preserve the caller's machine identity for deployment artifacts.
          const principal = yield* buildStepPrincipal(context)
          const fileId = yield* fileOps.createFile(
            store.id,
            args.contentType ?? undefined,
            principal.uid.type === "PF::ServiceAccount"
              ? `service-account:${principal.uid.id}`
              : principal.uid.id,
          )

          // Request upload URL from storage backend
          return yield* docStoreService.requestUploadUrl({
            fileId,
            storePrefix: store.name,
            ...(context.jwt?.properties.workload && {
              expiresAt: Math.min(
                context.jwt.properties.workload.expiresAt,
                context.jwt.exp * 1000,
              ),
            }),
            ...(args.contentType != null && {
              contentType: args.contentType,
            }),
            ...(args.filename != null && { filename: args.filename }),
          })
        }),

      requestDatabaseUploadUrl: (
        _parent: unknown,
        args: {
          project: string
          env: string
          contentType?: string | null
          filename?: string | null
        },
        context: UserContext,
      ) => requestDatabaseUploadUrl(args, context),

      deleteFile: (
        _parent: unknown,
        args: { fileId: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const fileOps = yield* FileOperations
          const docStoreService = yield* DocumentStoreService

          // Build principal first (for consistent timing whether file exists or not)
          const principal = yield* buildStepPrincipal(context)

          // Look up file owner info for authorization and store info for cleanup
          const fileInfo = yield* fileOps.getFileOwnerInfo(args.fileId)
          const fileWithStore = yield* fileOps.getFileWithStore(args.fileId)

          // Idempotent: if file doesn't exist, return success (owner is implicitly the requester)
          if (!fileInfo || !fileWithStore) {
            return { success: true }
          }

          // Check file-level Cedar authorization (owner only)
          const auth = yield* AuthorizationService
          const fileResource = new FileRef(
            args.fileId,
            fileInfo.createdBy,
            fileInfo.orgUnitPath,
            fileInfo.documentStorePath,
          )
          const canDelete = yield* auth.canDeleteFile(principal, fileResource)
          if (!canDelete) {
            return yield* new NotAuthorized({
              action: "delete",
              resource: args.fileId,
              message: `User ${principal.uid.id} is not authorized to delete file ${args.fileId}`,
            })
          }

          // Delete the file record (hard delete)
          // Return value intentionally ignored — file may already be gone (idempotent)
          yield* fileOps.deleteFile(args.fileId)

          // Also delete the storage object (S3 or local) if file was already uploaded
          // This prevents storage leaks for already-uploaded files
          if (!fileWithStore.uploadPending) {
            yield* docStoreService
              .deleteFile(args.fileId, fileWithStore.storeName)
              .pipe(
                Effect.catch((error: DocumentStoreError) =>
                  Effect.log("Failed to delete storage object (best-effort)", {
                    fileId: args.fileId,
                    storeName: fileWithStore.storeName,
                    error: error.message,
                  }),
                ),
              )
          }

          return { success: true }
        }),
      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
  }

  return {
    typeDefs: systemTypeDefs,
    resolvers,
  }
})
