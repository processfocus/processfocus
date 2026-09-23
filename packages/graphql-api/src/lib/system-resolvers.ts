import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { QueueService } from "@processfocus/runtime"
import {
  Data,
  DateTime,
  Duration,
  Effect,
  Either,
  Option,
  Schedule,
  Schema,
} from "effect"
import { LocalCedarConfig, PolicyWatcherService } from "@pf/auth-local-cedar"
import {
  Execution as AuthExecution,
  AuthorizationService,
  DelegationPrincipal,
  FileRef,
  ListRef,
  ProviderUserPrincipal,
  RoleRef,
  ServiceAccountPrincipal,
} from "@pf/auth-policy"
import {
  type DocumentStoreError,
  DocumentStoreService,
  FileNotFoundError,
} from "@pf/document-store-service"
import { omitClientFormDefinitionFields } from "@pf/form-client-representation"
import {
  type CalendarSlotFieldMetadata,
  Email,
  FormCalendarSlotInput,
  FormLookupInput,
  FormPermission,
  FormProviderUserInput,
  type LookupFieldMetadata,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
import {
  CleanupOperations,
  EXECUTION_EVENT_QUEUE,
  ExecutionQueries,
  FileOperations,
  FlowExecutionOperations,
  IMMUTABLE_INVITATION_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  InvitationLifecycleStatus,
  InvitationSource,
  NOTIFICATION_DELIVERY_QUEUE,
  NO_ACTIVE_REGISTRATION_LINK_MESSAGE,
  OAuthClientQueries,
  OrgQueries,
  type OrgUnitRow,
  PROCESS_EVENT_QUEUE,
  ProcessQueries,
  ProviderUserQueries,
  type ProviderUserRow,
  type PublicTodoInfo,
  REGISTRATION_LINK_CONFLICT_MESSAGE,
  RegistrationLinkStatus,
  type RoleRow,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  type SettingsInvitationRow,
  SettingsQueries,
  type SettingsRoleRow,
  StepCompletionOperations,
  StepRoleQueries,
  TODO_EVENT_QUEUE,
  TRUSTED_FRONTEND_ORIGIN_NOT_CONFIGURED_MESSAGE,
  TodoQueries,
  WorkflowQueries,
  deepMerge,
  issueRegistrationLink,
  mapRegistrationLinkCryptoError,
  normalizeExternalParticipantEmail,
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
  buildPublicTodoUrl,
  buildRegistrationLinkUrl,
  decryptRegistrationLinkToken,
} from "@pf/graphql-schema"
import {
  type FlowContext,
  type Form,
  FormComponentType,
  type List,
  LookupFieldNotFoundError,
  OrganisationProvider,
  type StatsView,
  type StepMeta,
  buildFlowContext,
  countLeafFields,
  normalizePath,
  pathToPascalCase,
} from "@pf/process"
import { TodoSummaryComputation } from "@pf/todo-summary"
import {
  buildPrincipal,
  buildStepPrincipal,
  canModifyField,
  checkListUpdateAuthorization,
  checkPublicCompletionCorrectionAuthorization,
  checkPublicTodoAuthorization,
  checkStepAuthorization,
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
import {
  checkExecutionAbandonAuthorization,
  isAbandonableExecutionStatus,
} from "./execution-abandon-authorization"
import { parseExecutionListStatus } from "./execution-list-filters"
import {
  hasPendingSystemStartRestartDispatch,
  restartFailedSystemStartExecution,
} from "./execution-restart"
import { omitFormMetadataFields } from "./form-metadata-projection"
import { ListExportService } from "./list-export"
import {
  canModifyListFieldForAnyRole,
  rolePathsForList,
} from "./list-field-authorization"
import { validateProcessListStatus } from "./process-list-filters"
import {
  completeStep,
  recoverExternalCompletionEnqueue,
} from "./process-operations"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  type PublicTodoTokenPayload,
  decryptPublicTodoToken,
  encryptPublicTodoToken,
} from "./public-todo-token"
import { getSchemaAnnotationDeep, getSubmissionFields } from "./resolver-utils"
import { ExecutionCollectionOps } from "./rxdb/execution"
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
  Duration.millis(100),
)
const SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE = Schedule.exponential(
  "100 millis",
  2,
).pipe(Schedule.intersect(Schedule.recurs(3)))
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

const isTokenExpired = (exp: number, now: DateTime.DateTime) =>
  // Match capability-token UX: a link expires at the start of its expiry second.
  exp <= Math.floor(DateTime.toEpochMillis(now) / 1000)

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

const hasProviderUserInput = (fieldSchema: Schema.Schema.Any): boolean =>
  Option.isSome(getSchemaAnnotationDeep(fieldSchema, FormProviderUserInput))

type PublicTodoCapabilityResult =
  | {
      readonly type: "done"
      readonly result: PublicTodoResult
    }
  | {
      readonly type: "continue"
      readonly payload: PublicTodoTokenPayload
      readonly todo: PublicTodoInfo
      readonly stepPath: string
      readonly form: Form
    }

type PublicTodoCapability = Extract<
  PublicTodoCapabilityResult,
  { readonly type: "continue" }
>

const resolveMaybeEffect = <T>(
  value: T | Effect.Effect<T, unknown, unknown>,
) => (Effect.isEffect(value) ? value : Effect.succeed(value))

const normalizePublicRecipient = (
  recipient: string | { readonly email: string; readonly displayName?: string },
) =>
  typeof recipient === "string"
    ? { email: recipient }
    : {
        email: recipient.email,
        ...(recipient.displayName
          ? { displayName: recipient.displayName }
          : {}),
      }

const normalizePublicRecipientEmail = (email: string) =>
  email.trim().toLowerCase()

const resolveFunctionPublicCompletionThankYou = <
  TState,
  TSteps extends Record<string, StepMeta>,
  TItem,
>(
  thankYou: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => string | Effect.Effect<string, unknown, unknown>,
  state: TState,
  ctx: FlowContext<TSteps>,
  item: TItem,
): Effect.Effect<string, unknown, unknown> =>
  resolveMaybeEffect(thankYou(state, ctx, item))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const findClientComponentByField = (
  components: unknown,
  fieldName: string,
): Record<string, unknown> | null => {
  if (!isRecord(components)) {
    return null
  }

  for (const [componentName, component] of Object.entries(components)) {
    if (!isRecord(component)) {
      continue
    }

    // Public lookup requests use schema field names. Component keys cover the
    // normal top-level representation; explicit `field` metadata covers
    // components that were wrapped or transformed by the client representation.
    const field = component["field"]
    if (componentName === fieldName || field === fieldName) {
      return component
    }

    const children = component["children"] ?? component["itemChildren"]
    const nested = findClientComponentByField(children, fieldName)
    if (nested) {
      return nested
    }
  }

  return null
}

const publicLookupComponentRestriction = (
  component: Record<string, unknown> | null,
): "dependent" | "query-name" | null => {
  if (!component || component["_tag"] !== FormComponentType.Lookup) {
    return null
  }

  if (
    Array.isArray(component["dependencies"]) &&
    component["dependencies"].length > 0
  ) {
    return "dependent"
  }

  return typeof component["queryName"] === "string" ? "query-name" : null
}

const isPublicCalendarSlotComponent = (
  component: Record<string, unknown> | null,
): boolean => component?.["_tag"] === FormComponentType.CalendarSlot

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
  registrationLinkGeneratedBy: invitation.registrationLinkGeneratedBy,
  registrationLinkRevealedAt: invitation.registrationLinkRevealedAt,
  registrationLinkRevealedBy: invitation.registrationLinkRevealedBy,
  registrationLinkRevokedAt: invitation.registrationLinkRevokedAt,
  registrationLinkRevokedBy: invitation.registrationLinkRevokedBy,
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

/**
 * Raised inside the M2M invitation-bootstrap transaction when the pending
 * Invitation could not be accepted after create/assign, so the transaction
 * rolls back and no partial identity remains.
 */
class InvitationBootstrapFailed extends Data.TaggedError(
  "InvitationBootstrapFailed",
)<{
  readonly email: string
}> {}

/**
 * Raised when Cedar denies requestProviderUserPermissions after durable writes
 * already ran in the transaction (create/assign/accept). Failing the Effect
 * forces rollback so an unauthorized M2M client cannot burn an Invitation.
 */
class InvitationPermissionDenied extends Data.TaggedError(
  "InvitationPermissionDenied",
)<{
  readonly email: string
}> {}

const validateInvitationMutationInput = (
  settingsQueries: typeof SettingsQueries.Service,
  input: InvitationMutationInput,
  currentInvitationId?: string,
) =>
  Effect.gen(function* () {
    const emailResult = Schema.decodeUnknownEither(Email)(input.email)
    if (Either.isLeft(emailResult)) {
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

    const normalizedEmail = emailResult.right.toLowerCase()
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
          field as Schema.Schema.Any,
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
            Effect.catchAll(() => Effect.succeed(false)),
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
    enforceUserAuth: boolean,
  ) =>
    Effect.gen(function* () {
      const { organisation: org } = yield* OrganisationProvider
      const authorizationMessage = enforceUserAuth
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

      if (enforceUserAuth) {
        yield* checkStepAuthorization(context, args.stepPath)
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
          formDefinition: null,
          defaultValues: null,
          jsonSchema: null,
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
          formDefinition: null,
          defaultValues: null,
          jsonSchema: null,
        }
      }

      const currentProviderUser = currentProviderUserDefault(context)
      let defaultValues: Record<string, unknown> =
        yield* form.resolveInitialDefaults(currentProviderUser)

      const todoId = args.todoId
      const formDefinition = yield* todoId
        ? Effect.gen(function* () {
            const stepCompletionOps = yield* StepCompletionOperations
            const processStateData =
              yield* stepCompletionOps.getProcessStateByTodoId(todoId)

            if (!processStateData) {
              return yield* new ProcessStateNotFound({
                todoId,
                stepPath: args.stepPath,
                message: `Process state not found for todo "${todoId}"`,
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

            let item: unknown
            const todoInfo = yield* stepCompletionOps.queryTodoById(todoId)
            if (todoInfo?.itemData) {
              item = todoInfo.itemData
            }

            const resolvedDefaults = yield* form.resolveDefaults(
              processStateData.state,
              ctx as FlowContext<Record<string, never>>,
              item,
              currentProviderUser,
            )
            defaultValues = { ...defaultValues, ...resolvedDefaults }
            return yield* form.renderableClientFormDefinitionWithState(
              processStateData.state,
              ctx as FlowContext<Record<string, never>>,
              item,
            )
          })
        : !isStartStep
          ? form.renderableClientFormDefinition()
          : Effect.gen(function* () {
              const ctx = startFormContext(context)
              defaultValues = yield* form.resolveDefaults(
                {},
                ctx,
                undefined,
                currentProviderUser,
              )
              return yield* form.renderableClientFormDefinitionWithState(
                {},
                ctx,
              )
            })

      const hiddenFieldNames = yield* resolveHiddenFormFieldNames({
        form,
        stepPath: args.stepPath,
        context,
      })
      const visibleMetadata = omitFormMetadataFields({
        definition: formDefinition,
        defaultValues,
        jsonSchema: form.submissionSchema(),
        omittedFieldNames: hiddenFieldNames,
      })
      const visibleFormDefinition = visibleMetadata.formDefinition

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
        totalFields: countLeafFields(visibleMetadata.defaultValues),
        formDefinition: visibleFormDefinition,
        defaultValues: visibleMetadata.defaultValues,
        jsonSchema: visibleMetadata.jsonSchema,
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
    context: UserContext,
    options: { readonly allowExpired?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const payload = yield* decryptPublicTodoToken(token)
      const stepCompletionOps = yield* StepCompletionOperations
      const todo = yield* stepCompletionOps.queryPublicTodoInfo(payload.tid)

      if (todo.status === "unavailable" || !todo.stepPath) {
        return {
          type: "done",
          result: {
            todoId: payload.tid,
            status: "UNAVAILABLE",
            formMetadata: null,
          } satisfies PublicTodoResult,
        } satisfies PublicTodoCapabilityResult
      }

      if (
        todo.latestPublicCompletionInvitationRecipientEmail !== null &&
        (!payload.externalParticipantEmail ||
          normalizePublicRecipientEmail(payload.externalParticipantEmail) !==
            normalizePublicRecipientEmail(
              todo.latestPublicCompletionInvitationRecipientEmail,
            ))
      ) {
        return {
          type: "done",
          result: {
            todoId: payload.tid,
            status: "UNAVAILABLE",
            formMetadata: null,
          } satisfies PublicTodoResult,
        } satisfies PublicTodoCapabilityResult
      }

      // Completion is terminal for the UX, even after the capability expires,
      // but only the latest invitation recipient retains the capability.
      if (todo.status === "completed") {
        return {
          type: "done",
          result: {
            todoId: payload.tid,
            status: "COMPLETED",
            formMetadata: null,
          } satisfies PublicTodoResult,
        } satisfies PublicTodoCapabilityResult
      }

      if (
        !options.allowExpired &&
        isTokenExpired(payload.exp, context._requestTime)
      ) {
        return {
          type: "done",
          result: {
            todoId: payload.tid,
            status: "EXPIRED",
            formMetadata: null,
          } satisfies PublicTodoResult,
        } satisfies PublicTodoCapabilityResult
      }

      yield* checkPublicTodoAuthorization(payload.tid)

      const { organisation: org } = yield* OrganisationProvider
      const form = org.formByPath(todo.stepPath)
      if (!form) {
        yield* Effect.logError("Public todo form not found", {
          todoId: payload.tid,
          stepPath: todo.stepPath,
        })
        return {
          type: "done",
          result: {
            todoId: payload.tid,
            status: "UNAVAILABLE",
            formMetadata: null,
          } satisfies PublicTodoResult,
        } satisfies PublicTodoCapabilityResult
      }

      return {
        type: "continue",
        payload,
        todo,
        stepPath: todo.stepPath,
        form,
      } satisfies PublicTodoCapabilityResult
    })

  const resolvePublicTodo = (token: string, context: UserContext) =>
    Effect.gen(function* () {
      const capability = yield* validatePublicTodoCapability(token, context)
      if (capability.type === "done") {
        return capability.result
      }

      const { payload, stepPath } = capability
      const { organisation: org } = yield* OrganisationProvider
      const formMetadata = yield* resolveFormMetadata(
        { stepPath, todoId: payload.tid },
        context,
        false,
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
      const capability = yield* validatePublicTodoCapability(token, context)
      if (capability.type === "done") {
        if (capability.result.status === "COMPLETED") {
          yield* checkPublicTodoAuthorization(capability.result.todoId)
          yield* recoverExternalCompletionEnqueue(capability.result.todoId)
        }
        return capability.result
      }

      const { payload, form } = capability
      const publicCompletion = form.publicCompletion
      let completionMessage = "Successfully submitted."
      if (typeof publicCompletion?.thankYou === "string") {
        completionMessage = publicCompletion.thankYou
      } else if (typeof publicCompletion?.thankYou === "function") {
        // Function-based messages can depend on process state/context, so only
        // this path pays for the extra reads needed to evaluate them.
        const stepCompletionOps = yield* StepCompletionOperations
        const processStateData =
          yield* stepCompletionOps.getProcessStateByTodoId(payload.tid)
        if (!processStateData) {
          return yield* new ProcessStateNotFound({
            todoId: payload.tid,
            stepPath: capability.stepPath,
            message: `Process state not found for todo "${payload.tid}"`,
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
        const todoInfo = yield* stepCompletionOps.queryTodoById(payload.tid)
        const item = todoInfo?.itemData ?? undefined
        // The runtime Form type erases org-specific state/item generics; this
        // branch is guarded by `typeof thankYou === "function"` above.
        completionMessage = yield* resolveFunctionPublicCompletionThankYou(
          publicCompletion.thankYou as (
            state: Record<string, unknown>,
            ctx: FlowContext<Record<string, StepMeta>>,
            item: unknown,
          ) => string | Effect.Effect<string, unknown, unknown>,
          processStateData.state as Record<string, unknown>,
          ctx as FlowContext<Record<string, StepMeta>>,
          item,
        )
      }

      yield* completeStep(
        payload.tid,
        input,
        form,
        form.submissionEffectSchema,
        context,
        {
          source: "public",
          ...(payload.externalParticipantEmail
            ? { externalParticipantEmail: payload.externalParticipantEmail }
            : {}),
        },
      )

      return {
        todoId: payload.tid,
        status: "COMPLETED",
        completionMessage,
        formMetadata: null,
      } satisfies PublicTodoResult
    })

  const loadPublicCompletionRuntimeContext = (
    capability: PublicTodoCapability,
  ) =>
    Effect.gen(function* () {
      const { payload, form } = capability
      const typedForm = form as Form<
        Record<string, unknown>,
        Record<string, StepMeta>,
        Schema.Struct.Fields,
        string,
        unknown
      >
      const publicCompletion = typedForm.publicCompletion
      if (!publicCompletion) return null

      const stepCompletionOps = yield* StepCompletionOperations
      const processStateData = yield* stepCompletionOps.getProcessStateByTodoId(
        payload.tid,
      )
      if (!processStateData) return null

      const completedSteps =
        yield* stepCompletionOps.getCompletedStepsForExecution(
          processStateData.processExecutionId,
        )
      const ctx = buildFlowContext(
        processStateData.processExecutionId,
        processStateData.processStartedAt,
        completedSteps,
      ) as FlowContext<Record<string, StepMeta>>
      const item = capability.todo.itemData ?? undefined

      return { publicCompletion, processStateData, ctx, item }
    })

  const enqueueFreshPublicCompletionInvitation = (
    capability: PublicTodoCapability,
    context: UserContext,
    state: Record<string, unknown>,
    ctx: FlowContext<Record<string, StepMeta>>,
    item: unknown,
  ) =>
    Effect.gen(function* () {
      const { payload, form, stepPath } = capability
      const typedForm = form as Form<
        Record<string, unknown>,
        Record<string, StepMeta>,
        Schema.Struct.Fields,
        string,
        unknown
      >
      const publicCompletion = typedForm.publicCompletion
      if (!publicCompletion) return null

      const recipient = normalizePublicRecipient(
        yield* resolveMaybeEffect(publicCompletion.recipient(state, ctx, item)),
      )
      const expiresAt = yield* resolveMaybeEffect(
        publicCompletion.expiresAt(state, ctx, item),
      )
      const expiresAtIso = DateTime.formatIso(expiresAt)
      const stepName = form.props.name ?? stepPath.split("/").at(-1) ?? stepPath
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
      const stepCompletionOps = yield* StepCompletionOperations
      const publicCompletionInvitationAttemptId =
        yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
          todoId: payload.tid,
          recipientEmail: recipient.email,
        })
      const freshToken = yield* encryptPublicTodoToken({
        v: 1,
        tid: payload.tid,
        externalParticipantEmail: recipient.email,
        publicCompletionInvitationAttemptId,
        iat: Math.floor(DateTime.toEpochMillis(context._requestTime) / 1000),
        exp: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000),
        aud: payload.aud,
      })
      const publicUrl = buildPublicTodoUrl(frontendOrigin, freshToken)
      const subject = publicCompletion.subject
        ? yield* resolveMaybeEffect(
            publicCompletion.subject(state, ctx, item, publicUrl, expiresAt),
          )
        : undefined
      const body = publicCompletion.body
        ? yield* resolveMaybeEffect(
            publicCompletion.body(state, ctx, item, publicUrl, expiresAt),
          )
        : undefined
      const template = publicCompletion.template
        ? yield* resolveMaybeEffect(
            publicCompletion.template(state, ctx, item, publicUrl, expiresAt),
          )
        : undefined
      const attachments = publicCompletion.attachments
        ? yield* resolveMaybeEffect(
            publicCompletion.attachments(state, ctx, item),
          )
        : undefined

      const queueService = yield* QueueService
      const freshLinkPayload = {
        channel: "email" as const,
        recipient,
        publicTodo: {
          todoId: payload.tid,
          processName: form.process.props.name,
          stepName,
          token: freshToken,
          expiresAt: expiresAtIso,
          publicCompletionInvitationAttemptId,
          ...(subject !== undefined && { subject }),
          ...(body !== undefined && { body }),
          ...(template !== undefined && { template }),
          ...(attachments !== undefined && { attachments }),
        },
      }

      yield* queueService
        .enqueue(NOTIFICATION_DELIVERY_QUEUE, freshLinkPayload)
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Failed to enqueue public completion invitation after recording invitation attempt",
              {
                todoId: payload.tid,
                publicCompletionInvitationAttemptId,
                error: String(error),
              },
            ),
          ),
        )

      return { recipient, publicCompletionInvitationAttemptId }
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
    Effect.gen(function* () {
      const normalizedCorrectedEmail =
        normalizeExternalParticipantEmail(correctedEmail)
      if (!normalizedCorrectedEmail) {
        return yield* new InputValidationError({
          errors: [
            {
              field: "correctedEmail",
              message: "Enter a valid email address.",
            },
          ],
        })
      }

      const stepCompletionOps = yield* StepCompletionOperations
      const todo = yield* stepCompletionOps.queryTodoById(todoId)
      if (!todo?.correctionRequiredAt) {
        return yield* new NotAuthorized({
          action: "publicCompletionCorrection",
          resource: todoId,
          message: `Public completion todo ${todoId} is not available for correction`,
        })
      }

      yield* checkPublicCompletionCorrectionAuthorization(context, {
        id: todo.id,
        stepPath: todo.targetStepPath,
        processPath: todo.processPath,
        processOrgUnitPath: todo.orgUnitPath,
        assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
      })

      const { organisation: org } = yield* OrganisationProvider
      const form = org.formByPath(todo.targetStepPath)
      const typedForm = form as
        | Form<
            Record<string, unknown>,
            Record<string, StepMeta>,
            Schema.Struct.Fields,
            string,
            unknown
          >
        | undefined
      const publicCompletion = typedForm?.publicCompletion
      const correction = publicCompletion?.correction
      if (!typedForm || !publicCompletion || !correction) {
        return yield* new NotAuthorized({
          action: "publicCompletionCorrection",
          resource: todoId,
          message: `Public completion todo ${todoId} is not configured for correction`,
        })
      }

      const processStateData =
        yield* stepCompletionOps.getProcessStateByTodoId(todoId)
      if (!processStateData) {
        return yield* new ProcessStateNotFound({
          todoId,
          stepPath: todo.targetStepPath,
          message: `Process state not found for todo "${todoId}"`,
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
      const item = todo.itemData ?? undefined
      const patch = yield* resolveMaybeEffect(
        correction.applyEmail(
          processStateData.state,
          normalizedCorrectedEmail,
          ctx,
          item,
        ),
      )
      if (!isRecord(patch)) {
        return yield* new InputValidationError({
          errors: [
            {
              field: "correctedEmail",
              message: "Correction did not produce a process-state patch.",
            },
          ],
        })
      }

      const nextState = deepMerge(processStateData.state, patch)
      const resolvedRecipient = normalizePublicRecipient(
        yield* resolveMaybeEffect(
          publicCompletion.recipient(nextState, ctx, item),
        ),
      )
      const normalizedResolvedEmail = normalizeExternalParticipantEmail(
        resolvedRecipient.email,
      )
      if (normalizedResolvedEmail !== normalizedCorrectedEmail) {
        return yield* new InputValidationError({
          errors: [
            {
              field: "correctedEmail",
              message:
                "The corrected process state does not resolve to this email address.",
            },
          ],
        })
      }

      const capability: PublicTodoCapability = {
        type: "continue",
        // Only tid and aud are read when issuing the replacement token; iat/exp
        // are recomputed from the current request time and public-completion TTL.
        payload: {
          v: 1,
          tid: todoId,
          iat: 0,
          exp: 0,
          aud: PUBLIC_TODO_TOKEN_AUDIENCE,
        },
        todo: {
          todoId,
          status: "active",
          stepPath: todo.targetStepPath,
          // Correction submissions already resolved the recipient from the
          // provider-supplied correction, so stale public invitation checks do
          // not apply when issuing the replacement token.
          latestPublicCompletionInvitationRecipientEmail: null,
          itemData: todo.itemData,
        },
        stepPath: todo.targetStepPath,
        form: typedForm as Form,
      }

      const queueService = yield* QueueService
      const enqueueTodoProcessExecutionEvents = Effect.gen(function* () {
        yield* queueService.enqueue(TODO_EVENT_QUEUE, { todoIds: [todoId] })

        const flowExecutionOps = yield* FlowExecutionOperations
        const processId = yield* flowExecutionOps.getProcessIdForExecution(
          processStateData.processExecutionId,
        )
        if (processId) {
          yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
        } else {
          yield* Effect.logWarning(
            "Unable to enqueue process event after public completion correction",
            {
              executionId: processStateData.processExecutionId,
              todoId,
            },
          )
        }

        yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
          executionId: processStateData.processExecutionId,
        })
      })
      const clearCorrectionRequired = Effect.gen(function* () {
        const cleared =
          yield* stepCompletionOps.clearPublicCompletionCorrectionRequired(
            todoId,
          )
        if (!cleared) {
          return yield* new NotAuthorized({
            action: "publicCompletionCorrection",
            resource: todoId,
            message: `Public completion todo ${todoId} is no longer available for correction`,
          })
        }
      })
      const reissueInvitation = enqueueFreshPublicCompletionInvitation(
        capability,
        context,
        nextState,
        ctx,
        item,
      )

      const transactionalApplyAndReissue = Effect.gen(function* () {
        yield* stepCompletionOps.updateProcessState(
          processStateData.processStateId,
          patch,
        )
        yield* clearCorrectionRequired
        yield* reissueInvitation
        yield* enqueueTodoProcessExecutionEvents
      })

      if (queueService.queueInTransaction) {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(transactionalApplyAndReissue)
      } else {
        yield* stepCompletionOps.updateProcessState(
          processStateData.processStateId,
          patch,
        )
        // Without transactional queueing, enqueue before clearing the correction
        // so a failed enqueue leaves the provider-facing correction flow intact.
        // If clearing fails after enqueue, a retry can send another invitation.
        yield* reissueInvitation
        yield* clearCorrectionRequired
        yield* enqueueTodoProcessExecutionEvents
      }

      return {
        todoId,
        processName: typedForm.process.props.name,
        stepName:
          typedForm.props.name ??
          todo.targetStepPath.split("/").at(-1) ??
          todo.targetStepPath,
        correctedEmail: normalizedCorrectedEmail,
        failureReason: null,
      }
    })

  const publicTodoLookupSuggestions = (
    args: {
      token: string
      field: string
      filter?: string | null
      limit?: number | null
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

      // Public lookup authorization only inspects static component metadata.
      // Render-time dynamic text belongs to the form metadata response path.
      const hiddenFieldNames = yield* resolveHiddenFormFieldNames({
        form,
        stepPath,
        context,
      })
      const formDefinition = omitClientFormDefinitionFields(
        yield* form.clientFormDefinition(),
        hiddenFieldNames,
      )
      const lookupComponent = findClientComponentByField(
        formDefinition.components,
        args.field,
      )
      if (!lookupComponent) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public lookup field ${args.field} is not authorized`,
        })
      }
      const lookupRestriction =
        publicLookupComponentRestriction(lookupComponent)
      if (lookupRestriction) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message:
            lookupRestriction === "dependent"
              ? `Public dependent lookup field ${args.field} is not authorized`
              : `Public query-name lookup field ${args.field} is not authorized`,
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
          getSchemaAnnotationDeep(
            fieldSchema as Schema.Schema.Any,
            FormPermission,
          ),
        )
      ) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public permission-gated lookup field ${args.field} is not authorized`,
        })
      }

      if (hasProviderUserInput(fieldSchema as Schema.Schema.Any)) {
        return yield* new NotAuthorized({
          action: "lookup",
          resource: args.field,
          message: `Public provider-user lookup field ${args.field} is not authorized`,
        })
      }

      const metadata = (fieldSchema as Schema.Schema.Any).ast.annotations?.[
        FormLookupInput
      ] as LookupFieldMetadata | undefined
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
      const filter = args.filter ?? ""
      const limit = Math.max(0, Math.min(args.limit ?? 20, 100))

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

      // Public calendar-slot authorization only inspects static component
      // metadata. Dynamic text resolution must not run in this auth path.
      const hiddenFieldNames = yield* resolveHiddenFormFieldNames({
        form,
        stepPath,
        context,
      })
      const formDefinition = omitClientFormDefinitionFields(
        yield* form.clientFormDefinition(),
        hiddenFieldNames,
      )
      if (
        !isPublicCalendarSlotComponent(
          findClientComponentByField(formDefinition.components, args.field),
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
          getSchemaAnnotationDeep(
            fieldSchema as Schema.Schema.Any,
            FormPermission,
          ),
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
          fieldSchema as Schema.Schema.Any,
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

  const requestFreshPublicTodoLink = (token: string, context: UserContext) =>
    Effect.gen(function* () {
      const capability = yield* validatePublicTodoCapability(token, context, {
        allowExpired: true,
      })
      if (capability.type === "done") {
        return capability.result
      }

      const runtimeContext =
        yield* loadPublicCompletionRuntimeContext(capability)
      if (!runtimeContext) {
        return {
          todoId: capability.payload.tid,
          status: "UNAVAILABLE",
          formMetadata: null,
        } satisfies PublicTodoResult
      }

      const queueService = yield* QueueService
      if (queueService.queueInTransaction) {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          enqueueFreshPublicCompletionInvitation(
            capability,
            context,
            runtimeContext.processStateData.state,
            runtimeContext.ctx,
            runtimeContext.item,
          ),
        )
      } else {
        // External queues cannot share this DB transaction; an orphaned attempt
        // is acceptable if enqueue fails because no provider send happened.
        yield* enqueueFreshPublicCompletionInvitation(
          capability,
          context,
          runtimeContext.processStateData.state,
          runtimeContext.ctx,
          runtimeContext.item,
        )
      }

      return {
        todoId: capability.payload.tid,
        status: "ACTIVE",
        formMetadata: null,
      } satisfies PublicTodoResult
    })

  const resolvers: ResolverMap = {
    Query: {
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
            authorizeRows: (rows) => filterAuthorizedProcessRows(context, rows),
          })
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
          // Check if providerUserID is present in session
          if (!context.userId) {
            return yield* new NoProviderUserID({
              message: "No provider user ID found in session context",
            })
          }

          const providerUserOption =
            yield* providerUserQueries.queryProviderUserByUserId(context.userId)

          // Check if provider user was found
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
      ) => resolveFormMetadata(args, context, true),

      publicCompletionCorrection: (
        _parent: unknown,
        args: { todoId: string },
        context: UserContext,
      ) => queryPublicCompletionCorrection(args.todoId, context),

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

          // Find the list by path
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

          const formDefinition = yield* list.clientFormDefinition()

          // Generate JSON schema for editable fields only
          const jsonSchema = list.formSubmissionSchema()

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
            formDefinition,
            defaultValues,
            jsonSchema,
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

          // Map to ListInfo type
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
              return {
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

      lookupSuggestions: (
        _parent: unknown,
        args: {
          stepPath: string
          field: string
          filter?: string | null
          limit?: number | null
          todoId?: string | null
        },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const { organisation: org } = yield* OrganisationProvider
          const filter = args.filter ?? ""
          const limit = Math.max(0, Math.min(args.limit ?? 20, 100))

          // First try a normal form step path.
          const form = org.formByPath(args.stepPath)
          if (form) {
            yield* checkStepAuthorization(context, args.stepPath)
            const fieldSchema = getSubmissionFields(form.output)[args.field]
            const permission = fieldSchema
              ? getSchemaAnnotationDeep(
                  fieldSchema as Schema.Schema.Any,
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
                    Effect.catchAll(() => Effect.succeed(false)),
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
              hasProviderUserInput(fieldSchema as Schema.Schema.Any)
            ) {
              return yield* providerUserLookupSuggestions(
                context,
                filter,
                limit,
              )
            }

            if (args.todoId && !form.lookupOverrides().has(args.field)) {
              const stepCompletionOps = yield* StepCompletionOperations
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

              return yield* statefulForm.executeLookupWithState(
                args.field,
                filter,
                limit,
                processStateData.state,
                ctx as FlowContext<Record<string, StepMeta>>,
                todoInfo.itemData ?? undefined,
              )
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

          // Also support list item edit forms, where the frontend passes
          // the list path as stepPath.
          const list = org.listByPath(args.stepPath)
          if (list?.hasForm) {
            const listPath = normalizePath(list.node.path)
            const rolePaths = rolePathsForList(list.roles)

            yield* checkListUpdateAuthorization(context, listPath, rolePaths)

            const fieldSchema = getSubmissionFields(list.editableFormFields())[
              args.field
            ]
            if (!fieldSchema) {
              return yield* new LookupFieldNotFoundError({
                fieldName: args.field,
                formStep: listPath,
                message: `Lookup field "${args.field}" not found in list form "${listPath}"`,
              })
            }

            const permission = getSchemaAnnotationDeep(
              fieldSchema as Schema.Schema.Any,
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
              hasProviderUserInput(fieldSchema as Schema.Schema.Any)
            ) {
              return yield* providerUserLookupSuggestions(
                context,
                filter,
                limit,
              )
            }

            const metadata = (fieldSchema as Schema.Schema.Any).ast
              .annotations?.[FormLookupInput] as LookupFieldMetadata | undefined

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
            fieldSchema as Schema.Schema.Any,
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
                  Effect.catchAll(() => Effect.succeed(false)),
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

          // Get all roles in the system
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

          if (!context.userId) {
            return {
              success: false,
              rolePath: null,
              error: "Not authenticated",
            }
          }
          const userId = context.userId

          // Check if role exists
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

          // Check Cedar authorization
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
            // Provider user: write to permitted_role table
            if (!providerUser) {
              return {
                success: false,
                rolePath: null,
                error: "Provider user not found",
              }
            }

            // This is a single upsert statement, so retry lock contention
            // directly instead of starting a separate transaction.
            yield* providerUserDb
              .addPermittedRole(providerUser.id, role.id)
              .pipe(Effect.retry(SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE))

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

      requestProviderUserPermissions: (
        _parent: unknown,
        args: { email: string },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          yield* rejectUnsupportedDelegationHandoff(
            context.jwt?.properties,
            "impersonation",
          )
          const auth = yield* AuthorizationService
          const providerUserDb = yield* ProviderUserQueries
          const oauthClientDb = yield* OAuthClientQueries
          const sql = yield* SqlClient.SqlClient

          // Get M2M client info from context
          const props = context.jwt?.properties
          if (!props || !("clientId" in props)) {
            return { success: false, email: null, error: "Invalid session" }
          }
          const m2mProps = props as {
            clientId: string
            roles?: readonly string[]
          }

          // Get OAuth client from database
          const clientOption = yield* oauthClientDb.queryOAuthClientByClientId(
            m2mProps.clientId,
          )
          if (Option.isNone(clientOption)) {
            return {
              success: false,
              email: null,
              error: "OAuth client not found",
            }
          }
          const client = clientOption.value

          const normalizedEmail = args.email.trim().toLowerCase()
          const settingsQueries = yield* SettingsQueries
          const principal = new ServiceAccountPrincipal(
            m2mProps.clientId,
            m2mProps.roles ?? [],
          )

          const authorizeRequest = (
            email: string,
            roles: readonly string[],
            orgUnitId: string,
          ) =>
            auth
              .canRequestProviderUserPermissions(
                principal,
                new ProviderUserPrincipal(email, { roles, orgUnitId }),
              )
              .pipe(
                Effect.catchTag("AuthorizationError", (e) =>
                  Effect.fail(
                    new NotAuthorized({
                      action: "requestProviderUserPermissions",
                      resource: email,
                      message: e.message,
                    }),
                  ),
                ),
              )

          // Transaction: get/create provider user, then upsert permission
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Step 1: Find or create provider user
                let providerUserOpt =
                  yield* providerUserDb.queryProviderUserByEmail(
                    normalizedEmail,
                  )

                if (Option.isNone(providerUserOpt)) {
                  // No provider user - check for invitation
                  const invitationRoleIds =
                    yield* providerUserDb.findInvitationRoleIds(normalizedEmail)

                  if (invitationRoleIds.length === 0) {
                    // No provider user AND no invitation - fail early
                    return {
                      success: false,
                      email: null,
                      error: `Provider user not found and no invitation exists for: ${normalizedEmail}`,
                    }
                  }

                  const rootOrgUnitOpt = yield* providerUserDb.findRootOrgUnit()
                  if (Option.isNone(rootOrgUnitOpt)) {
                    return {
                      success: false,
                      email: null,
                      error: "No root org unit found",
                    }
                  }

                  // Authorize against the intended invitation grant before any
                  // durable bootstrap writes. Soft-deny is safe here (no side
                  // effects yet).
                  const invitationRoles =
                    yield* settingsQueries.queryRolesByIds(invitationRoleIds)
                  const invitationRolePaths = invitationRoles.map(
                    (role) => role.path,
                  )
                  const canBootstrap = yield* authorizeRequest(
                    normalizedEmail,
                    invitationRolePaths,
                    rootOrgUnitOpt.value.id,
                  )
                  if (!canBootstrap) {
                    return {
                      success: false,
                      email: null,
                      error: `Not authorized to request permissions for: ${normalizedEmail}`,
                    }
                  }

                  const newProviderUser =
                    yield* providerUserDb.createProviderUserFromInvitation({
                      email: normalizedEmail,
                      orgUnitId: rootOrgUnitOpt.value.id,
                    })
                  yield* providerUserDb.assignProviderUserRoles(
                    newProviderUser.providerUserId,
                    invitationRoleIds,
                  )
                  const accepted =
                    yield* providerUserDb.acceptPendingInvitationForProviderUser(
                      {
                        email: normalizedEmail,
                        providerUserId: newProviderUser.providerUserId,
                        provider: "m2m",
                        subject: `m2m:${normalizedEmail}`,
                      },
                    )
                  if (!accepted) {
                    // Concurrent acceptance won or invitation was revoked mid-flight.
                    // Fail the Effect so the transaction rolls back create/assign.
                    return yield* new InvitationBootstrapFailed({
                      email: normalizedEmail,
                    })
                  }

                  // Re-fetch the provider user with full details
                  providerUserOpt =
                    yield* providerUserDb.queryProviderUserByEmail(
                      normalizedEmail,
                    )
                }

                const providerUser = Option.getOrThrow(providerUserOpt)

                // Step 2: Cedar authorization against the actual provider user.
                // After durable bootstrap writes, denial must fail the Effect so
                // the transaction rolls back rather than committing a burned grant.
                const providerUserRolePaths =
                  yield* providerUserDb.queryProviderUserRolePaths(
                    providerUser.id,
                  )
                const canRequest = yield* authorizeRequest(
                  providerUser.email,
                  providerUserRolePaths,
                  providerUser.orgUnitId,
                )
                if (!canRequest) {
                  return yield* new InvitationPermissionDenied({
                    email: normalizedEmail,
                  })
                }

                // Step 3: Upsert to permitted_client_email (with retry for SQLite locks)
                yield* oauthClientDb
                  .addPermittedClientEmail(client.id, normalizedEmail)
                  .pipe(Effect.retry(SQLITE_PERMISSION_WRITE_RETRY_SCHEDULE))

                return { success: true, email: normalizedEmail, error: null }
              }),
            )
            .pipe(
              Effect.catchTag("InvitationBootstrapFailed", (error) =>
                Effect.succeed({
                  success: false,
                  email: null,
                  error: `Pending invitation could not be consumed for: ${error.email}`,
                }),
              ),
              Effect.catchTag("InvitationPermissionDenied", (error) =>
                Effect.succeed({
                  success: false,
                  email: null,
                  error: `Not authorized to request permissions for: ${error.email}`,
                }),
              ),
            )

          return result
        }),

      createInvitation: (
        _parent: unknown,
        args: {
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

          const validation = yield* validateInvitationMutationInput(
            settingsQueries,
            args.input,
          )
          if (!validation.success) {
            return {
              __typename: "SaveInvitationFailure" as const,
              error: validation.error,
            }
          }

          const invitationId = yield* sql.withTransaction(
            Effect.gen(function* () {
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

              return createdInvitationId
            }),
          )

          const invitation =
            yield* settingsQueries.queryInvitationDetail(invitationId)
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
          const result = yield* issueRegistrationLink({
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
          const result = yield* issueRegistrationLink({
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
          }
        },
        _context: UserContext,
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
              // Replace role assignments
              yield* settingsQueries.replaceProviderUserRoles(
                args.providerUserId,
                args.input.roleIds,
              )
            }),
          )

          // Fetch updated provider user data
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
        }),

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
      ) =>
        Effect.gen(function* () {
          const auth = yield* AuthorizationService
          const executionQueries = yield* ExecutionQueries
          const stepCompletionOps = yield* StepCompletionOperations
          const flowExecutionOps = yield* FlowExecutionOperations
          const queueService = yield* QueueService
          const sql = yield* SqlClient.SqlClient

          // 1. Get execution
          const executions = yield* executionQueries.getExecutions([
            args.executionId,
          ])
          const execution = executions[0]
          if (!execution) {
            return {
              success: false,
              restartedCount: 0,
              error: `Execution not found: ${args.executionId}`,
            }
          }

          // 2. Build principal and resource
          const principal = yield* buildStepPrincipal(context)
          const resource = new AuthExecution(
            args.executionId,
            execution.startedByEmail,
            execution.processPath,
            [], // empty orgUnitPaths - only checking startedBy
          )

          // 3. Check authorization
          const canRestart = yield* auth.canRestartExecution(
            principal,
            resource,
          )
          if (!canRestart) {
            return {
              success: false,
              restartedCount: 0,
              error: "Not authorized to restart this execution",
            }
          }

          // 4. Query failed todos
          const failedTodos =
            yield* stepCompletionOps.queryFailedTodosForExecution(
              args.executionId,
            )

          // 5. Get process ID for events
          const processId = yield* flowExecutionOps.getProcessIdForExecution(
            args.executionId,
          )

          // 5b. Todo-less system-start restart:
          // - Failed roleless start (execution-level failure, no Todo), or
          // - Pending external restart outbox after reopen committed but SQS
          //   drain failed (status is already Running; sequential GraphQL retry
          //   must still recover the outbox).
          if (failedTodos.length === 0) {
            const isRolelessStart = execution.startStepRoleId === null
            const isFailedSystemStart =
              execution.status === "Failed" &&
              isRolelessStart &&
              execution.abandonedReason != null

            const pendingExternalRestart =
              isRolelessStart &&
              execution.status !== "Abandoned" &&
              (yield* hasPendingSystemStartRestartDispatch(args.executionId))

            if (!isFailedSystemStart && !pendingExternalRestart) {
              return {
                success: false,
                restartedCount: 0,
                error: "No failed todos found for this execution",
              }
            }

            return yield* restartFailedSystemStartExecution({
              executionId: args.executionId,
              stepId: execution.startStepId,
              stepPath: execution.startStepPath,
              processId,
            })
          }

          // Helper to enqueue all jobs (system step re-execution + event notifications)
          const systemStepTodos = failedTodos.filter((t) => t.isSystemStep)
          const enqueueJobs = Effect.gen(function* () {
            // Enqueue system-step-execution jobs for each failed system step
            for (const todo of systemStepTodos) {
              const retryLimit =
                yield* flowExecutionOps.getStepRetryLimitByPath(todo.stepPath)
              yield* queueService.enqueue(
                SYSTEM_STEP_EXECUTION_QUEUE,
                {
                  todoId: todo.todoId,
                  stepPath: todo.stepPath,
                  processExecutionId: args.executionId,
                },
                {
                  logicalJobId: `system-step:${todo.todoId}`,
                  ...(retryLimit === null ? {} : { retryLimit }),
                },
              )
            }

            // Publish event notifications
            if (failedTodos.length > 0) {
              yield* queueService.enqueue(TODO_EVENT_QUEUE, {
                todoIds: failedTodos.map((t) => t.todoId),
              })
            }

            yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
              executionId: args.executionId,
              processId,
              eventType: "updated",
            })

            yield* queueService.enqueue(PROCESS_EVENT_QUEUE, {
              processId,
              eventType: "updated",
            })
          })

          // 6. In transaction: clear failures, reset execution, and enqueue if DB-backed queue
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // Clear todo failures
              yield* stepCompletionOps.clearTodoFailures(
                failedTodos.map((t) => t.todoId),
              )

              // Clear execution finished status
              yield* stepCompletionOps.clearProcessExecutionFinished(
                args.executionId,
              )

              // For DB-backed queues, enqueue inside transaction to avoid lock contention
              if (queueService.queueInTransaction) {
                yield* enqueueJobs
              }
            }),
          )

          // For external queues (SQS), enqueue after transaction commits
          // to ensure data is visible in the database before handlers run
          if (!queueService.queueInTransaction) {
            yield* enqueueJobs
          }

          // 7. Return result
          return {
            success: true,
            restartedCount: failedTodos.length,
            error: null,
          }
        }),

      abandonExecution: (
        _parent: unknown,
        args: { executionId: string; reason?: string | null },
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const executionQueries = yield* ExecutionQueries
          const stepCompletionOps = yield* StepCompletionOperations
          const scheduledFlowOps = yield* ScheduledFlowOperations
          const flowExecutionOps = yield* FlowExecutionOperations
          const queueService = yield* QueueService
          const sqlClient = yield* SqlClient.SqlClient

          // 1. Get execution
          const executions = yield* executionQueries.getExecutions([
            args.executionId,
          ])
          const execution = executions[0]
          if (!execution) {
            return {
              success: false,
              error: `Execution not found: ${args.executionId}`,
            }
          }

          // 2. Check abandonable status
          if (!isAbandonableExecutionStatus(execution.status)) {
            return {
              success: false,
              error: "Only running or failed executions can be abandoned",
            }
          }

          // 3. Build principal
          const principal = yield* buildStepPrincipal(context)

          // 4. Step-based authorization check
          const abandonAuthorization =
            yield* checkExecutionAbandonAuthorization(
              principal,
              args.executionId,
              execution.status,
              { startStepPath: execution.startStepPath },
            )

          if (!abandonAuthorization.hasAbandonableSteps) {
            return {
              success: false,
              error: "No active steps found for this execution",
            }
          }

          if (!abandonAuthorization.authorized) {
            return {
              success: false,
              error: "Not authorized to abandon this execution",
            }
          }

          // 5. Get processId for events
          const processId = yield* flowExecutionOps.getProcessIdForExecution(
            args.executionId,
          )

          // 6. In transaction: abandon execution, soft-delete todos, delete scheduled flows
          const deletedTodoIds = yield* sqlClient.withTransaction(
            Effect.gen(function* () {
              yield* stepCompletionOps.setProcessExecutionAbandoned(
                args.executionId,
                args.reason ?? undefined,
              )
              const todoIds =
                yield* stepCompletionOps.softDeleteActiveTodosForExecution(
                  args.executionId,
                )
              yield* scheduledFlowOps.deleteScheduledFlowsForExecution(
                args.executionId,
              )

              return todoIds
            }),
          )

          // 7. Enqueue event notifications after transaction commits
          yield* Effect.gen(function* () {
            yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
              executionId: args.executionId,
              processId,
              eventType: "updated",
            })

            // Only enqueue todo events if there were deleted todos
            if (deletedTodoIds.length > 0) {
              yield* queueService.enqueue(TODO_EVENT_QUEUE, {
                todoIds: deletedTodoIds,
              })
            }

            yield* queueService.enqueue(PROCESS_EVENT_QUEUE, {
              processId,
              eventType: "updated",
            })
          })

          // 7. Return success
          return {
            success: true,
            error: null,
          }
        }),

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

          // Create file row in DB with the current user as the owner
          const principal = yield* buildPrincipal(context)
          const fileId = yield* fileOps.createFile(
            store.id,
            args.contentType ?? undefined,
            principal.uid.id,
          )

          // Request upload URL from storage backend
          return yield* docStoreService.requestUploadUrl({
            fileId,
            storePrefix: store.name,
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
          const principal = yield* buildPrincipal(context)

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
                Effect.catchAll((error: DocumentStoreError) =>
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
