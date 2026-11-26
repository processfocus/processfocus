import { randomUUID } from "node:crypto"
import { QueueService } from "@processfocus/runtime"
import type { Context } from "effect"
import {
  Data,
  DateTime,
  Duration,
  Effect,
  Option,
  Schedule,
  Schema,
  SchemaAST,
} from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { recordDeploymentAudit } from "@pf/audit/deployment"
import { AuthorizationService, ProviderUserPrincipal } from "@pf/auth-policy"
import {
  calculateBusinessDuration,
  makeBusinessCalendarService,
} from "@pf/business-calendar"
import {
  type ProcessStartTrigger,
  recordSuccessfulExternalAction,
  recordSuccessfulProcessStart,
  recordSuccessfulStepCompletion,
} from "@pf/business-metrics"
import {
  getTransactionMode,
  isSqlLockError,
  withConcurrentTransaction,
  withImmediateTransaction,
  withReadSnapshot,
} from "@pf/db-info"
import {
  FormPermission,
  FormProviderUserInput,
  fieldAnnotation,
  fieldInputAst,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
import {
  executableFields,
  executableOriginalValues,
  extractValidationErrors,
  getSchemaAnnotationDeep,
  getSubmissionFields,
  prepareExecutableSubmission,
} from "@pf/form-submission-schema"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
  ExternalParticipantOperations,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  type InvalidExternalParticipantEmail,
  type NewFlowDispatchJob,
  PROCESS_EVENT_QUEUE,
  ProcessExecutionOperations,
  type ProcessState,
  ProviderUserQueries,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  StepRoleQueries,
  TODO_EVENT_QUEUE,
  type TodoForCompletion,
  TodoNotFoundError,
  buildCalendarConfig,
  getStartedSystemStepCompletedJobId,
  getUserDetails,
  hasCalendarConfigured,
  normalizeExternalParticipantEmail,
} from "@pf/graphql-db-operations"
import {
  ExecutionIdConflictError,
  InputValidationError,
  NotAuthorized,
  StepCompletionConflictError,
} from "@pf/graphql-schema/errors"
import {
  type FlowContext,
  type Form,
  OrganisationProvider,
  type ProcessProps,
  type StepMeta,
  buildFlowContext,
  getStepIdFromPath,
  mergeFormDefaults,
  normalizePath,
  resolveFormFieldDefaults,
  toCamelCase,
} from "@pf/process"
import { getRequestTime } from "@pf/request-time"
import { buildStepPrincipal, canModifyField } from "./authorization"
import { chatFields } from "./chat-form"
import type { ExecutionIdentity } from "./identity"
import {
  isProviderUserSession,
  processStartTriggerForSession,
} from "./identity"
import { runProcessActivation } from "./process-activation"
import { startFormContext } from "./start-form-context"
import { type TodoActor, authorizeTodo } from "./todo-admission"

/**
 * Error thrown when a todo's step path doesn't match the expected step path.
 */
class TodoStepMismatchError extends Data.TaggedError("TodoStepMismatchError")<{
  readonly todoId: string
  readonly expectedStepPath: string
  readonly actualStepPath: string
}> {}

class RetryStepCompletion extends Data.TaggedError("RetryStepCompletion")<{
  readonly reason: "state-conflict" | "todo-conflict"
}> {}

class ReplayStepCompletion extends Data.TaggedError("ReplayStepCompletion")<{
  readonly executionId: string
}> {}

const COMPLETE_STEP_MAX_ATTEMPTS = 5
const EXTERNAL_COMPLETION_DISPATCH_PREFIX = "step-completion:"
const EXTERNAL_COMPLETION_OUTBOX_QUEUE = "internal-completion-outbox"
const EXTERNAL_COMPLETION_RECOVERY_BATCH_SIZE = 100
const EXTERNAL_COMPLETION_DISPATCH_LEASE_MILLIS = 5 * 60_000
// Leave a minute for the next enqueue and acknowledgment. SQS has no explicit
// send timeout; an overlong send still relies on receipt fencing and replay.
const EXTERNAL_COMPLETION_DISPATCH_RENEWAL_MILLIS = 60_000
const COMPLETE_STEP_RETRY_SCHEDULE = Schedule.max([
  Schedule.exponential("25 millis", 2),
  Schedule.recurs(COMPLETE_STEP_MAX_ATTEMPTS - 1),
]).pipe(Schedule.jittered)

const isRetryableStepCompletionError = (error: unknown): boolean =>
  error instanceof RetryStepCompletion || isSqlLockError(error)

const externalCompletionDispatchId = (todoId: string) =>
  `${EXTERNAL_COMPLETION_DISPATCH_PREFIX}${todoId}`

const externalCompletionDispatchJobs = (params: {
  readonly todoId: string
  readonly processExecutionId: string
  readonly processId: string | undefined
  readonly scheduledFlowId: string
}): readonly NewFlowDispatchJob[] => {
  const dispatchId = externalCompletionDispatchId(params.todoId)
  const jobs: NewFlowDispatchJob[] = [
    {
      sourceScheduledFlowId: dispatchId,
      storageQueue: EXTERNAL_COMPLETION_OUTBOX_QUEUE,
      processExecutionId: params.processExecutionId,
      logicalJobId: `todo-event:completion:${params.todoId}`,
      queue: TODO_EVENT_QUEUE,
      payload: { todoIds: [params.todoId] },
      retryLimit: null,
      scheduledAt: null,
      sequence: 0,
    },
  ]
  if (params.processId) {
    jobs.push({
      sourceScheduledFlowId: dispatchId,
      storageQueue: EXTERNAL_COMPLETION_OUTBOX_QUEUE,
      processExecutionId: params.processExecutionId,
      logicalJobId: `process-event:completion:${params.todoId}`,
      queue: PROCESS_EVENT_QUEUE,
      payload: { processId: params.processId },
      retryLimit: null,
      scheduledAt: null,
      sequence: jobs.length,
    })
  }
  jobs.push(
    {
      sourceScheduledFlowId: dispatchId,
      storageQueue: EXTERNAL_COMPLETION_OUTBOX_QUEUE,
      processExecutionId: params.processExecutionId,
      logicalJobId: `execution-event:completion:${params.todoId}`,
      queue: EXECUTION_EVENT_QUEUE,
      payload: { executionId: params.processExecutionId },
      retryLimit: null,
      scheduledAt: null,
      sequence: jobs.length,
    },
    {
      sourceScheduledFlowId: dispatchId,
      storageQueue: EXTERNAL_COMPLETION_OUTBOX_QUEUE,
      processExecutionId: params.processExecutionId,
      logicalJobId: `flow-execution:${params.scheduledFlowId}`,
      queue: FLOW_EXECUTION_QUEUE,
      payload: { scheduledFlowId: params.scheduledFlowId },
      retryLimit: null,
      scheduledAt: null,
      sequence: jobs.length + 1,
    },
  )
  return jobs
}

const recoverExternalCompletionDispatches = (dispatchIds: readonly string[]) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    if (queueService.queueInTransaction) return

    const flowExecutionOps = yield* FlowExecutionOperations
    if (dispatchIds.length === 0) return
    const now = yield* DateTime.now
    const receipt = randomUUID()
    const initialLockedUntil = DateTime.add(now, {
      milliseconds: EXTERNAL_COMPLETION_DISPATCH_LEASE_MILLIS,
    })
    const jobs = yield* flowExecutionOps.claimFlowDispatchJobsBatch(
      dispatchIds,
      now,
      initialLockedUntil,
      receipt,
    )
    const leases = new Map<string, DateTime.Utc>()
    const unavailableDispatches = new Set<string>()
    const sent: Array<{ id: string; receipt: string }> = []
    const result = yield* Effect.gen(function* () {
      for (const job of jobs) {
        const dispatchId = job.sourceScheduledFlowId
        if (unavailableDispatches.has(dispatchId)) continue
        const lockedUntil = leases.get(dispatchId) ?? initialLockedUntil
        const checkedAt = yield* DateTime.now
        const remainingMillis =
          DateTime.toEpochMillis(lockedUntil) -
          DateTime.toEpochMillis(checkedAt)
        // A paused drainer leaves expired jobs available for recovery.
        if (remainingMillis <= 0) {
          unavailableDispatches.add(dispatchId)
          continue
        }
        if (remainingMillis <= EXTERNAL_COMPLETION_DISPATCH_RENEWAL_MILLIS) {
          const nextLockedUntil = DateTime.add(checkedAt, {
            milliseconds: EXTERNAL_COMPLETION_DISPATCH_LEASE_MILLIS,
          })
          const renewed = yield* flowExecutionOps.extendFlowDispatchClaim(
            dispatchId,
            receipt,
            nextLockedUntil,
          )
          if (!renewed) {
            unavailableDispatches.add(dispatchId)
            continue
          }
          leases.set(dispatchId, nextLockedUntil)
        } else if (
          !(yield* flowExecutionOps.ownsFlowDispatchJob(
            job.id,
            receipt,
            checkedAt,
          ))
        ) {
          unavailableDispatches.add(dispatchId)
          continue
        }

        yield* queueService.enqueue(job.queue, job.payload, {
          logicalJobId: job.logicalJobId,
          ...(job.retryLimit === null ? {} : { retryLimit: job.retryLimit }),
        })
        sent.push({ id: job.id, receipt })
      }
    }).pipe(Effect.exit)
    yield* Effect.gen(function* () {
      const deleted = yield* flowExecutionOps.deleteFlowDispatchJobs(sent)
      if (deleted.length !== sent.length) {
        yield* Effect.logWarning(
          "External completion dispatch lease changed after enqueue",
          { dispatchIds },
        )
      }
      yield* result
    }).pipe(
      Effect.tapError(() =>
        Effect.forEach(dispatchIds, (dispatchId) =>
          flowExecutionOps.releaseFlowDispatchJobs(dispatchId, receipt),
        ),
      ),
    )
  })

export const recoverExternalCompletionEnqueue = (todoId: string) =>
  recoverExternalCompletionDispatches([externalCompletionDispatchId(todoId)])

export const recoverPendingExternalCompletionBatch = (
  onSelected?: (dispatchCount: number) => void,
) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const now = yield* DateTime.now
    const dispatchIds =
      yield* flowExecutionOps.queryFlowDispatchIdsByStorageQueue(
        EXTERNAL_COMPLETION_OUTBOX_QUEUE,
        now,
        EXTERNAL_COMPLETION_RECOVERY_BATCH_SIZE,
      )
    onSelected?.(dispatchIds.length)
    yield* recoverExternalCompletionDispatches(dispatchIds)
    return dispatchIds.length
  })

export const recoverPendingExternalCompletionEnqueues =
  recoverPendingExternalCompletionBatch()

interface StartProcessExecutionOptions {
  readonly onSubmit?: Effect.Effect<void, InputValidationError>
  readonly validateActivation?: ProcessProps["validateActivation"]
  readonly withoutWaiting?: boolean
  readonly executionId?: string
  readonly enqueueStartSystemStep?: boolean
  readonly externalParticipantEmail?: string
  readonly trigger?: ProcessStartTrigger
  /** Role path that authorized this step completion (resolved to role ID for completed_by_role) */
  readonly completingRolePath?: string
}

interface CompleteStepOptions {
  readonly actor?: TodoActor
  readonly completionFingerprint?: string
  /** Public capability provenance, including legacy links without participant email. */
  readonly source?: "public"
  readonly externalParticipantEmail?: string
}

const invalidExternalParticipantEmailError = (
  error: InvalidExternalParticipantEmail,
) =>
  new InputValidationError({
    errors: [
      {
        field: "externalParticipantEmail",
        message: error.message,
      },
    ],
  })

type StartExecutionResult =
  | {
      readonly deduplicated: false
      readonly executionId: string
      readonly stepId: string
      readonly scheduledFlowId?: string
    }
  | {
      readonly deduplicated: true
      readonly executionId: string
      readonly stepId: string
    }

interface ProviderUserTargetField {
  readonly fieldName: string
  readonly value: unknown
}

interface EffectiveRuleState {
  readonly path: readonly (string | number)[]
  readonly hidden?: boolean
  readonly disabled?: boolean
  readonly required?: boolean
  readonly label?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const deletePathValue = (
  value: unknown,
  path: readonly (string | number)[],
): void => {
  if (path.length === 0) return
  const [segment, ...rest] = path
  if (segment === undefined) return

  if (Array.isArray(value)) {
    if (typeof segment === "number") {
      if (segment >= value.length) return
      if (rest.length === 0) {
        value.splice(segment, 1)
        return
      }
      deletePathValue(value[segment], rest)
      return
    }

    for (const item of value) {
      deletePathValue(item, path)
    }
    return
  }

  if (typeof segment === "number" || !isRecord(value)) return
  if (!Object.hasOwn(value, segment)) return
  if (rest.length === 0) {
    delete value[segment]
    return
  }
  deletePathValue(value[segment], rest)
}

const setPathDeleteMarker = (
  target: ProcessState,
  path: readonly (string | number)[],
): void => {
  if (path.length === 0) return
  const [segment, ...rest] = path
  // JSON Merge Patch deletes object members, not array indexes.
  if (typeof segment !== "string") return

  if (rest.length === 0) {
    target[segment] = null
    return
  }

  // Arrays are replaced wholesale by the already sanitized, decoded submission.
  // Descendant deletion markers would turn that replacement into an object patch.
  if (Array.isArray(target[segment])) return

  if (!isRecord(target[segment])) {
    target[segment] = {}
  }
  setPathDeleteMarker(target[segment] as ProcessState, rest)
}

const compareHiddenDeletePaths = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number => {
  // Delete children before ancestors, and numeric array sibling paths from high
  // to low index so one hidden value cannot shift another hidden value's path.
  // Numeric paths are defensive; typed form-rule authoring does not expose
  // per-index array targets today.
  const leftParent = left.slice(0, -1)
  const rightParent = right.slice(0, -1)
  if (
    leftParent.length === rightParent.length &&
    leftParent.every((segment, index) => segment === rightParent[index])
  ) {
    const leftLast = left[left.length - 1]
    const rightLast = right[right.length - 1]
    if (typeof leftLast === "number" && typeof rightLast === "number") {
      return rightLast - leftLast
    }
  }

  return right.length - left.length
}

const getEffectiveFormRuleStates = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  input: ProcessState,
  inaccessible: readonly string[] = [],
): EffectiveRuleState[] =>
  executableFields(step.sharedSchema, input, inaccessible)
    .filter(
      (field) =>
        field.kind === "input" &&
        !inaccessible.some((name) => field.path[0] === name),
    )
    .map((field) => ({
      path: field.path,
      state: field.state,
    }))
    .map(
      (entry): EffectiveRuleState => ({
        path: entry.path,
        ...(entry.state.hidden === undefined
          ? {}
          : { hidden: entry.state.hidden }),
        ...(entry.state.disabled === undefined
          ? {}
          : { disabled: entry.state.disabled }),
        ...(entry.state.required === undefined
          ? {}
          : { required: entry.state.required }),
        ...(entry.state.label === undefined
          ? {}
          : { label: entry.state.label }),
      }),
    )

const getHiddenRulePaths = (
  effectiveStates: readonly EffectiveRuleState[],
): readonly (readonly (string | number)[])[] =>
  effectiveStates
    .filter((entry) => entry.hidden === true)
    .map((entry) => entry.path)
    .sort(compareHiddenDeletePaths)

const applyAuthoritativeFormRules = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  input: ProcessState,
  preservedValues: ProcessState = {},
  inaccessible: readonly string[] = [],
) =>
  Effect.gen(function* () {
    const prepared = prepareExecutableSubmission(
      step.sharedSchema,
      input,
      preservedValues,
      inaccessible,
    )
    if (prepared.errors.length > 0)
      return yield* new InputValidationError({ errors: [...prepared.errors] })
    // Inapplicable fields cannot influence rules or be edited, but retain server-owned values.
    for (const name of inaccessible) {
      if (Object.hasOwn(preservedValues, name))
        prepared.values[name] = preservedValues[name]
    }
    return prepared.values
  })

const astMatchesValue = (value: unknown, ast: SchemaAST.AST): boolean => {
  if (fieldAnnotation(ast, FormProviderUserInput) !== undefined) {
    return typeof value === "string"
  }

  if (ast.encoding) return astMatchesValue(value, SchemaAST.toEncoded(ast))
  switch (ast._tag) {
    case "Null":
      return value === null
    case "String":
      return typeof value === "string"
    case "Number":
      return typeof value === "number"
    case "Boolean":
      return typeof value === "boolean"
    case "Undefined":
      return value === undefined
    case "Literal":
      return value === (ast as { readonly literal: unknown }).literal
    case "Objects":
      return (
        isRecord(value) &&
        ast.propertySignatures.every((prop) => {
          if (typeof prop.name !== "string") return true
          if (prop.type._tag !== "Literal") return true
          if (!Object.hasOwn(value, prop.name)) {
            return prop.type.context?.isOptional === true
          }
          return value[prop.name] === prop.type.literal
        })
      )
    case "Arrays":
      return Array.isArray(value)
    case "Union":
      return ast.types.some((member) => astMatchesValue(value, member))
    default:
      // Unknown AST nodes may wrap provider-user annotations; keep traversing
      // rather than accidentally skipping an authorization check.
      return true
  }
}

const dedupeProviderUserTargets = (
  targets: ProviderUserTargetField[],
): ProviderUserTargetField[] => [
  ...new Map(
    targets.map((target) => [
      `${target.fieldName}\0${String(target.value)}`,
      target,
    ]),
  ).values(),
]

const collectProviderUserTargetsFromAst = (
  fieldName: string,
  value: unknown,
  ast: SchemaAST.AST,
): ProviderUserTargetField[] => {
  if (fieldAnnotation(ast, FormProviderUserInput) !== undefined) {
    return [{ fieldName, value }]
  }

  if (ast.encoding)
    return collectProviderUserTargetsFromAst(
      fieldName,
      value,
      SchemaAST.toEncoded(ast),
    )
  switch (ast._tag) {
    case "Objects":
      if (!isRecord(value)) return []
      return ast.propertySignatures.flatMap((prop) => {
        if (typeof prop.name !== "string") return []
        return collectProviderUserTargetsFromAst(
          `${fieldName}.${prop.name}`,
          value[prop.name],
          prop.type,
        )
      })
    case "Arrays": {
      if (!Array.isArray(value)) return []
      const fixedTargets = ast.elements.flatMap((element, index) =>
        collectProviderUserTargetsFromAst(
          `${fieldName}.${index}`,
          value[index],
          element,
        ),
      )
      const itemType = ast.rest[0]
      if (!itemType) return fixedTargets
      return fixedTargets.concat(
        value
          .slice(ast.elements.length)
          .flatMap((item, index) =>
            collectProviderUserTargetsFromAst(
              `${fieldName}.${index + ast.elements.length}`,
              item,
              itemType,
            ),
          ),
      )
    }
    case "Union":
      return dedupeProviderUserTargets(
        ast.types
          .filter((member) => astMatchesValue(value, member))
          .flatMap((member) =>
            collectProviderUserTargetsFromAst(fieldName, value, member),
          ),
      )
    default:
      return []
  }
}

const collectProviderUserTargets = (
  input: ProcessState,
  fields: Schema.Struct.Fields,
): ProviderUserTargetField[] => {
  const targets = Object.entries(fields).flatMap(([fieldName, field]) =>
    collectProviderUserTargetsFromAst(
      fieldName,
      input[fieldName],
      fieldInputAst(field),
    ),
  )
  return dedupeProviderUserTargets(targets)
}

// "pex-" (4) + up to 37 chars matches the length of generated ULID-based IDs.
const MAX_EXECUTION_ID_LENGTH = 41
const EXECUTION_ID_PATTERN = /^pex-[A-Za-z0-9][A-Za-z0-9-]*$/

const validateExecutionId = (executionId: string) => {
  if (
    executionId.length > MAX_EXECUTION_ID_LENGTH ||
    !EXECUTION_ID_PATTERN.test(executionId)
  ) {
    return Effect.fail(
      new InputValidationError({
        errors: [
          {
            field: "executionId",
            message:
              "must start with 'pex-', be followed by a letter or number, contain only letters, numbers, and hyphens, and be at most 41 characters",
          },
        ],
      }),
    )
  }

  return Effect.succeed(executionId)
}

const currentProviderUserDefault = (
  context: ExecutionIdentity | undefined,
): string | undefined =>
  isProviderUserSession(context?.session) ? context.session.email : undefined

const checkRestrictedFieldSubmissions = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  context: ExecutionIdentity,
  stepPath: string,
  input: ProcessState,
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  fields: Schema.Struct.Fields = getSubmissionFields(step.output),
) =>
  Effect.gen(function* () {
    const restrictedFields = Object.entries(fields).flatMap(
      ([fieldName, field]) => {
        const permission = getSchemaAnnotationDeep(field, FormPermission)
        if (!Option.isSome(permission)) return []
        if (!isFieldPermissionMetadata(permission.value)) return []
        return [
          {
            fieldName,
            rolePath: normalizePath(permission.value.modify.node.path),
          },
        ]
      },
    )

    const inaccessible: string[] = []
    if (restrictedFields.length === 0) return inaccessible

    const stepRoleQueries = yield* StepRoleQueries
    const stepRoleInfo =
      yield* stepRoleQueries.queryRolePathsByStepPath(stepPath)
    const processPath = step.process.node.path

    for (const field of restrictedFields) {
      const allowed = yield* canModifyField(context, {
        stepPath,
        fieldName: field.fieldName,
        rolePath: field.rolePath,
        stepRolePath: stepRoleInfo.rolePath,
        processPath,
        orgUnitId: step.process.orgUnit.node.path,
        stepStartsProcess: stepRoleInfo.startsProcess,
        stepEmbedded: stepRoleInfo.embedded,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Field authorization check failed", {
            error,
            fieldName: field.fieldName,
            stepPath,
          }).pipe(Effect.as(false)),
        ),
      )

      if (!allowed) inaccessible.push(field.fieldName)
      if (!allowed && Object.hasOwn(input, field.fieldName)) {
        return yield* new NotAuthorized({
          action: "modifyField",
          resource: `${stepPath}/${field.fieldName}`,
          message: `User is not authorized to modify field ${field.fieldName}`,
        })
      }
    }
    return inaccessible
  })

export const checkProviderUserTargetFields = (
  context: ExecutionIdentity,
  input: ProcessState,
  fields: Schema.Struct.Fields,
) =>
  Effect.gen(function* () {
    const providerUserFields = collectProviderUserTargets(input, fields)

    if (providerUserFields.length === 0) return

    const providerUserQueries = yield* ProviderUserQueries
    const auth = yield* AuthorizationService
    const principal = yield* buildStepPrincipal(context)
    const currentUser = context.userId
      ? yield* providerUserQueries.queryProviderUserByUserId(context.userId)
      : Option.none()

    for (const field of providerUserFields) {
      const value = field.value
      // Schema validation owns non-string type errors; authorization only
      // validates submitted provider-user targets.
      if (typeof value !== "string") continue

      if (value.length === 0) {
        return yield* new NotAuthorized({
          action: "actOnBehalfOf",
          resource: field.fieldName,
          message: `Provider user field ${field.fieldName} requires a non-empty value`,
        })
      }

      const selfValues = new Set(
        [
          context.userId,
          ...(Option.isSome(currentUser)
            ? [
                currentUser.value.id,
                currentUser.value.userId,
                currentUser.value.email,
              ]
            : []),
        ].filter((item): item is string => typeof item === "string"),
      )
      if (selfValues.has(value)) continue

      const byEmail = yield* providerUserQueries.queryProviderUserByEmail(value)
      const target = Option.isSome(byEmail)
        ? byEmail
        : yield* providerUserQueries
            .queryProviderUserByUserId(value)
            .pipe(
              Effect.flatMap((byUserId) =>
                Option.isSome(byUserId)
                  ? Effect.succeed(byUserId)
                  : providerUserQueries.queryProviderUserByProviderUserId(
                      value,
                    ),
              ),
            )

      if (Option.isNone(target)) {
        return yield* new NotAuthorized({
          action: "actOnBehalfOf",
          resource: value,
          message: `Provider user target for field ${field.fieldName} is not authorized`,
        })
      }

      const rolePaths = yield* providerUserQueries.queryProviderUserRolePaths(
        target.value.id,
      )

      if (rolePaths.length === 0) {
        return yield* new NotAuthorized({
          action: "actOnBehalfOf",
          resource: value,
          message: `Provider user target for field ${field.fieldName} is not authorized`,
        })
      }

      const targetPrincipal = new ProviderUserPrincipal(target.value.email, {
        roles: rolePaths,
        orgUnitId: target.value.orgUnitPath,
      })
      const allowed = yield* auth.canActOnBehalfOf(principal, targetPrincipal)

      if (!allowed) {
        return yield* new NotAuthorized({
          action: "actOnBehalfOf",
          resource: value,
          message: `User is not authorized to act on behalf of ${value}`,
        })
      }
    }
  })

const checkProviderUserTargets = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  context: ExecutionIdentity,
  input: ProcessState,
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  fields: Schema.Struct.Fields = getSubmissionFields(step.output),
) => checkProviderUserTargetFields(context, input, fields)

interface SqlErrorDetail {
  readonly message?: string
  readonly code?: string
  readonly table?: string
  readonly constraint?: string
  readonly detail?: string
}

const toSqlErrorDetail = (
  value: Record<string, unknown>,
  fallbackMessage?: string,
): SqlErrorDetail => {
  const message =
    typeof value["message"] === "string" ? value["message"] : fallbackMessage
  const code = typeof value["code"] === "string" ? value["code"] : undefined
  const table = typeof value["table"] === "string" ? value["table"] : undefined
  const constraint =
    typeof value["constraint"] === "string" ? value["constraint"] : undefined
  const detail =
    typeof value["detail"] === "string" ? value["detail"] : undefined

  return {
    ...(message !== undefined ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

const getSqlErrorDetails = (error: SqlError): ReadonlyArray<SqlErrorDetail> => {
  const details: SqlErrorDetail[] = [{ message: error.message }]
  let current: unknown = error.cause
  let depth = 0

  while (current && depth < 10) {
    if (current instanceof Error) {
      const value = current as Error & Record<string, unknown>
      details.push(toSqlErrorDetail(value, current.message))
      current = value["cause"]
      depth += 1
      continue
    }

    if (typeof current === "object" && current !== null) {
      const value = current as Record<string, unknown>
      details.push(toSqlErrorDetail(value))

      current = value["cause"]
      depth += 1
      continue
    }

    if (typeof current === "string") {
      details.push({ message: current })
    }

    break
  }

  return details
}

const isProcessExecutionIdConflictSqlError = (error: SqlError) =>
  getSqlErrorDetails(error).some((detail) => {
    const message = detail.message?.toLowerCase()
    const code = detail.code?.toLowerCase()
    const table = detail.table?.toLowerCase()
    const constraint = detail.constraint?.toLowerCase()
    const conflictDetail = detail.detail?.toLowerCase()

    if (
      message?.includes("unique constraint failed: pf_process_execution.id") ||
      message?.includes("unique constraint failed: process_execution.id")
    ) {
      return true
    }

    if (code !== "23505") {
      return false
    }

    if (table === "pf_process_execution") {
      return (
        constraint === "pf_process_execution_pkey" ||
        conflictDetail?.includes("(id)=") === true
      )
    }

    return (
      message?.includes(
        'duplicate key value violates unique constraint "pf_process_execution_pkey"',
      ) ?? false
    )
  })

/**
 * Calculate business duration for a step (todo).
 * Returns the duration in milliseconds.
 * If no calendar is configured, falls back to wallclock time.
 */
const calculateStepBusinessDuration = Effect.fn(
  "ProcessOperations.calculateStepBusinessDuration",
)(function* (
  calendarQueries: Context.Service.Shape<typeof BusinessCalendarQueries>,
  createdAtMs: number,
  completedAtMs: number,
  orgUnitId: string,
) {
  // Load calendar data for the org unit
  const calendarDataMap = yield* calendarQueries.getCalendarData([orgUnitId])
  const calendarData = calendarDataMap.get(orgUnitId)

  if (calendarData && hasCalendarConfigured(calendarData)) {
    // Use business hours calculation
    const config = yield* buildCalendarConfig(calendarData)
    const calendarService = yield* makeBusinessCalendarService(config)

    const duration = yield* calculateBusinessDuration(
      calendarService,
      createdAtMs,
      completedAtMs,
    )

    return Duration.toMillis(duration)
  }

  // Fallback: use wallclock time
  return completedAtMs - createdAtMs
})

/**
 * Starts a process execution within a transaction.
 * Creates process state, process execution, scheduled flow, and enqueues a job.
 * All operations are inside a single transaction for crash-safety.
 * The job handler is responsible for evaluating all outgoing flows from the start step.
 * Process and execution events are enqueued after the transaction to notify subscribers.
 */
export const startProcessExecution = (
  processId: string,
  processPath: string,
  startStepPath: string,
  state: ProcessState,
  options: StartProcessExecutionOptions = {},
) =>
  Effect.gen(function* () {
    const sqlClient = yield* SqlClient.SqlClient
    const processExecutionOps = yield* ProcessExecutionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const externalParticipantOps = yield* ExternalParticipantOperations
    const queueService = yield* QueueService
    const stepRoleQueries = yield* StepRoleQueries
    const requestTime = yield* getRequestTime()
    const enqueueStartSystemStep = options.enqueueStartSystemStep ?? false
    const trigger =
      options.externalParticipantEmail !== undefined
        ? "human"
        : (options.trigger ?? "automated")
    const callerExecutionId =
      options.executionId === undefined
        ? undefined
        : yield* validateExecutionId(options.executionId)
    const startedByExternalParticipantId = options.externalParticipantEmail
      ? yield* externalParticipantOps
          .upsertByEmail(options.externalParticipantEmail)
          .pipe(
            Effect.catchTag(
              "InvalidExternalParticipantEmail",
              invalidExternalParticipantEmailError,
            ),
          )
      : undefined
    const matchesLogicalStart = (startInfo: {
      readonly processId: string
      readonly startStepPath: string
      readonly withoutWaiting?: boolean
    }) =>
      // enqueueStartSystemStep is derived from the hydrated start node for this
      // startStepPath, not from caller input, so the persisted logical start is
      // identified by processId + startStepPath. Live process_state.state is
      // not part of that identity: the start system step patches outputs onto
      // the same row after start commits, so comparing inbound start state to
      // the live row would treat a retry as a conflict.
      (startInfo.withoutWaiting ?? false) ===
        (options.withoutWaiting ?? false) &&
      startInfo.processId === processId &&
      startInfo.startStepPath === startStepPath

    // Helper to enqueue all jobs (step/flow execution + event notifications)
    const enqueueJobs = (params: {
      readonly executionId: string
      readonly stepId: string
      readonly scheduledFlowId?: string
    }) =>
      Effect.gen(function* () {
        if (enqueueStartSystemStep) {
          yield* queueService.enqueue(SYSTEM_STEP_EXECUTION_QUEUE, {
            startsProcess: true as const,
            processExecutionId: params.executionId,
            stepId: params.stepId,
            stepPath: startStepPath,
          })
          yield* Effect.log(
            queueService.queueInTransaction
              ? "Staged start system step (provisional until outer commit)"
              : "Start system step scheduled",
            {
              processExecutionId: params.executionId,
              stepId: params.stepId,
              stepPath: startStepPath,
            },
          )
        } else {
          const { scheduledFlowId } = params
          if (!scheduledFlowId) {
            // Non-system starts always create a scheduled_flow. Reaching this
            // branch means the caller passed inconsistent start options.
            return yield* Effect.die(
              "Missing scheduledFlowId for non-system start",
            )
          }

          // Enqueue flow execution job - job payload only contains scheduledFlowId
          // Job handler will look up processExecutionId and sourceStepId from scheduled_flow table
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, { scheduledFlowId })
          yield* Effect.log(
            queueService.queueInTransaction
              ? "Staged flow (provisional until outer commit)"
              : "Flow scheduled",
            { scheduledFlowId },
          )
        }

        // Enqueue event notifications. No PROCESS_EVENT here: starting an
        // execution does not change the process document (activeInstances
        // counts to-dos, which only flow-execution creates), and publishing
        // the unchanged snapshot can deliver a stale document to subscribers
        // after the flow-execution-time publish.
        yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
          executionId: params.executionId,
        })
      })

    const enqueueRecoveredExternalQueueJobs = (params: {
      readonly executionId: string
      readonly stepId: string
    }) =>
      Effect.gen(function* () {
        const pendingStartScheduledFlowId =
          yield* scheduledFlowOps.getPendingStartScheduledFlowId(
            params.executionId,
            params.stepId,
          )

        if (!enqueueStartSystemStep) {
          if (pendingStartScheduledFlowId === null) {
            yield* Effect.log("Start flow already consumed before replay", {
              processExecutionId: params.executionId,
              stepId: params.stepId,
            })
            return
          }

          yield* enqueueJobs({
            executionId: params.executionId,
            stepId: params.stepId,
            scheduledFlowId: pendingStartScheduledFlowId,
          })
          return
        }

        if (pendingStartScheduledFlowId !== null) {
          // The started system step already published process/execution events
          // when it completed and inserted this downstream scheduled flow.
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
            scheduledFlowId: pendingStartScheduledFlowId,
          })
          yield* Effect.log("Recovered pending start flow enqueue", {
            scheduledFlowId: pendingStartScheduledFlowId,
            processExecutionId: params.executionId,
          })
          return
        }

        const completedJobOps = yield* Effect.serviceOption(
          CompletedJobOperations,
        )
        if (Option.isNone(completedJobOps)) {
          return yield* Effect.die(
            "CompletedJobOperations is required for started system-step replay recovery",
          )
        }

        const alreadyCompleted = yield* completedJobOps.value.isJobCompleted(
          SYSTEM_STEP_EXECUTION_QUEUE,
          getStartedSystemStepCompletedJobId(params.executionId),
        )

        if (alreadyCompleted) {
          return
        }

        yield* enqueueJobs({
          executionId: params.executionId,
          stepId: params.stepId,
        })
      })

    const completedByRoleId = options.completingRolePath
      ? yield* stepRoleQueries.queryRoleIdByPath(options.completingRolePath)
      : undefined
    if (options.completingRolePath && completedByRoleId === undefined) {
      yield* Effect.logWarning(
        "Completing role not found in DB; started_by_role will be null",
      ).pipe(
        Effect.annotateLogs({
          completingRolePath: options.completingRolePath,
        }),
      )
    }

    const validateActivation = (
      kind: "activation" | "receipt",
      executionId: string,
    ) =>
      options.validateActivation
        ? runProcessActivation(options.validateActivation, {
            kind,
            executionId,
            state,
          }).pipe(
            Effect.catchTag("FormSubmissionError", (error) =>
              Effect.fail(
                new InputValidationError({
                  errors: [{ field: error.field, message: error.message }],
                }),
              ),
            ),
          )
        : Effect.void

    const start = Effect.gen(function* () {
      // Insert process state and get the step ID
      const { processStateId, stepId } =
        yield* processExecutionOps.insertProcessState(
          processId,
          startStepPath,
          state,
          startedByExternalParticipantId,
          completedByRoleId,
        )

      // Insert process execution
      const executionId = yield* processExecutionOps.insertProcessExecution(
        processStateId,
        callerExecutionId,
        options.withoutWaiting ?? false,
      )

      if (options.onSubmit) yield* options.onSubmit
      yield* validateActivation("activation", executionId)

      const scheduledFlowId = enqueueStartSystemStep
        ? undefined
        : yield* scheduledFlowOps.insertScheduledFlow(executionId, stepId, {
            ...(completedByRoleId !== undefined ? { completedByRoleId } : {}),
          })

      // For DB-backed queues, enqueue all jobs inside transaction to avoid lock contention
      if (queueService.queueInTransaction) {
        yield* enqueueJobs({
          executionId,
          stepId,
          ...(scheduledFlowId !== undefined ? { scheduledFlowId } : {}),
        })
      }

      return {
        deduplicated: false as const,
        executionId,
        stepId,
        ...(scheduledFlowId !== undefined ? { scheduledFlowId } : {}),
      }
    })
    const startInTransaction = options.validateActivation
      ? withImmediateTransaction(sqlClient, start)
      : sqlClient.withTransaction(start)

    const startResult: StartExecutionResult =
      callerExecutionId === undefined
        ? yield* startInTransaction
        : yield* startInTransaction.pipe(
            // Re-read outside the failed transaction so the duplicate insert rolls
            // back cleanly before we compare the existing execution.
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.gen(function* () {
                if (!isProcessExecutionIdConflictSqlError(sqlError)) {
                  return yield* sqlError
                }

                const existingExecution =
                  yield* processExecutionOps.getProcessExecutionStartInfo(
                    callerExecutionId,
                  )

                if (!existingExecution) {
                  return yield* sqlError
                }

                if (!matchesLogicalStart(existingExecution)) {
                  return yield* new ExecutionIdConflictError({
                    executionId: callerExecutionId,
                  })
                }

                if (options.validateActivation)
                  yield* withReadSnapshot(
                    sqlClient,
                    validateActivation(
                      "receipt",
                      existingExecution.executionId,
                    ),
                  )

                return {
                  deduplicated: true as const,
                  executionId: existingExecution.executionId,
                  stepId: existingExecution.stepId,
                }
              }),
            ),
          )

    // The transaction is committed and retry deduplication is known here.
    // Emit before external queue work so an enqueue retry cannot double count.
    if (!startResult.deduplicated) {
      yield* recordDeploymentAudit(startResult.executionId, {
        subtype: "started",
        actor: yield* getUserDetails(),
      })
      if (options.externalParticipantEmail !== undefined) {
        yield* recordSuccessfulExternalAction("submission")
      }
      yield* recordSuccessfulProcessStart(trigger)
      if (!enqueueStartSystemStep) {
        yield* recordSuccessfulStepCompletion(trigger)
      }
    }

    // For external queues (SQS), enqueue jobs after transaction commits
    // This ensures the data is visible in the database before handlers run
    if (!queueService.queueInTransaction) {
      if (startResult.deduplicated) {
        yield* enqueueRecoveredExternalQueueJobs({
          executionId: startResult.executionId,
          stepId: startResult.stepId,
        })
      } else {
        yield* enqueueJobs({
          executionId: startResult.executionId,
          stepId: startResult.stepId,
          ...(startResult.scheduledFlowId !== undefined
            ? { scheduledFlowId: startResult.scheduledFlowId }
            : {}),
        })
      }
    }

    return {
      deduplicated: startResult.deduplicated,
      executionId: startResult.executionId,
      processId,
      processPath,
      timestamp: DateTime.formatIso(requestTime),
    }
  })

/** Runtime boundary: input has been decoded with this form's submission schema. */
const executeFormSubmission = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  input: ProcessState,
): Effect.Effect<void, InputValidationError> => {
  // Previously built organisation artifacts do not have this optional callback.
  if (typeof step.executeSubmit !== "function") return Effect.void
  // The runtime supplies organisation services, as for submissionEffectSchema.
  return step
    .executeSubmit(input as Parameters<typeof step.executeSubmit>[0])
    .pipe(
      Effect.mapError(
        (error) =>
          new InputValidationError({
            errors: [{ field: error.field, message: error.message }],
          }),
      ),
    ) as Effect.Effect<void, InputValidationError>
}

/**
 * Starts a process, validating input against schema first.
 * This is the extracted logic from the start mutation resolver,
 * without the authorization check.
 */
export const startProcess = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  processId: string,
  processPath: string,
  startStepPath: string,
  input: ProcessState,
  inputSchema: Schema.Top | undefined,
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  context: ExecutionIdentity,
  options?: StartProcessExecutionOptions,
) =>
  Effect.gen(function* () {
    const inaccessible = yield* checkRestrictedFieldSubmissions(
      context,
      startStepPath,
      input,
      step,
    )
    const currentProviderUser = currentProviderUserDefault(context)
    const startContext = startFormContext(
      context,
      yield* getRequestTime(),
    ) as FlowContext<TSteps>
    const startState = {} as TState
    const startFields = getSubmissionFields(
      step.getFieldsWithState(startState, startContext),
    )
    const preservedStartDefaults = yield* resolveFormFieldDefaults(
      startFields,
      currentProviderUser,
    )
    const defaultedInput = mergeFormDefaults(preservedStartDefaults, input)
    const ruleValidatedInput = yield* applyAuthoritativeFormRules(
      step,
      defaultedInput,
      preservedStartDefaults,
      inaccessible,
    )
    yield* checkProviderUserTargets(context, ruleValidatedInput, step)

    // Presence must be checked before schema decoding so blank values report as
    // required rather than falling through to email-format validation.
    const rawExternalParticipantEmail = step.embed
      ? ruleValidatedInput[step.embed.externalParticipantEmailField]
      : undefined

    if (
      step.embed &&
      (typeof rawExternalParticipantEmail !== "string" ||
        rawExternalParticipantEmail.trim().length === 0)
    ) {
      return yield* new InputValidationError({
        errors: [
          {
            field: step.embed.externalParticipantEmailField,
            message: "External participant email is required",
          },
        ],
      })
    }

    let validatedInput: ProcessState = ruleValidatedInput

    if (inputSchema) {
      // Validate flat input directly against the flat submission schema.
      // No wrapper expansion needed — inputSchema is already the flat
      // submission schema (with optional filterEffect for cross-field checks).
      validatedInput = (yield* Schema.decodeUnknownEffect(
        inputSchema as unknown as Schema.Codec<unknown, unknown, never, never>,
        { errors: "all" },
      )(ruleValidatedInput).pipe(
        Effect.mapError(
          (parseError) =>
            new InputValidationError({
              errors: extractValidationErrors(parseError),
            }),
        ),
      )) as ProcessState
    }

    for (const path of getHiddenRulePaths(
      getEffectiveFormRuleStates(step, defaultedInput, inaccessible),
    ))
      deletePathValue(validatedInput, path)

    const externalParticipantEmail = step.embed
      ? validatedInput[step.embed.externalParticipantEmailField]
      : undefined
    const normalizedExternalParticipantEmail =
      typeof externalParticipantEmail === "string"
        ? normalizeExternalParticipantEmail(externalParticipantEmail)
        : null

    // The configured field may be a plain text field, so validate email shape
    // after the form schema has accepted the rest of the submission.
    if (
      step.embed &&
      typeof externalParticipantEmail === "string" &&
      normalizedExternalParticipantEmail === null
    ) {
      return yield* new InputValidationError({
        errors: [
          {
            field: step.embed.externalParticipantEmailField,
            message: "External participant email must be a valid email address",
          },
        ],
      })
    }

    return yield* startProcessExecution(
      processId,
      processPath,
      startStepPath,
      validatedInput,
      {
        ...options,
        onSubmit: executeFormSubmission(step, validatedInput),
        validateActivation: step.process.props.validateActivation,
        trigger:
          options?.trigger ?? processStartTriggerForSession(context.session),
        // Upsert still normalizes defensively because public completions and
        // direct callers may not have gone through this embedded-form boundary.
        ...(normalizedExternalParticipantEmail
          ? { externalParticipantEmail: normalizedExternalParticipantEmail }
          : {}),
      },
    )
  })

/** Resolve defaults and validate answers against the current To-Do context. */
const prepareTodoForm = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>({
  todo,
  input,
  step,
  inputSchema,
  context,
  chat,
}: {
  readonly todo: Pick<
    TodoForCompletion,
    "id" | "processExecutionId" | "itemData"
  >
  readonly input: ProcessState
  readonly step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>
  readonly inputSchema: Schema.Top | undefined
  readonly context: ExecutionIdentity
  readonly chat: boolean
}) =>
  Effect.gen(function* () {
    const operations = yield* StepCompletionOperations
    const stepPath = normalizePath(step.node.path)
    const processStateData = yield* operations.getProcessStateByTodoId(todo.id)
    const requestTime = yield* getRequestTime()
    const completedSteps = processStateData
      ? yield* operations.getCompletedStepsForExecution(
          processStateData.processExecutionId,
        )
      : []
    const ctx = buildFlowContext(
      processStateData?.processExecutionId ?? todo.processExecutionId,
      processStateData?.processStartedAt ?? requestTime,
      completedSteps,
    ) as FlowContext<TSteps>
    const processState = processStateData?.state ?? {}
    const item = (todo.itemData ?? undefined) as TItem
    const resolvedFields = step.getFieldsWithState(
      processState as TState,
      ctx,
      item,
    )
    const fields = getSubmissionFields(resolvedFields)
    const inaccessible = yield* checkRestrictedFieldSubmissions(
      context,
      stepPath,
      input,
      step,
      fields,
    )
    const defaults = yield* resolveFormFieldDefaults(
      fields,
      currentProviderUserDefault(context),
    )
    const originals = executableOriginalValues(
      step.sharedSchema,
      defaults,
      processState,
    )
    const values = mergeFormDefaults(defaults, input)
    const fieldsInChat = chat
      ? chatFields({
          schema: step.sharedSchema,
          values,
          defaults: yield* resolveFormFieldDefaults(
            resolvedFields,
            currentProviderUserDefault(context),
          ),
          originals,
          input,
          inaccessible,
          presentation: step.resolvePresentation(processState, ctx, item),
        })
      : []
    const needsDashboard = fieldsInChat.some((field) => field.needsDashboard)
    const validate = Effect.gen(function* () {
      if (needsDashboard)
        return yield* new InputValidationError({
          errors: fieldsInChat
            .filter((field) => field.needsDashboard)
            .map((field) => ({
              field: field.name,
              message: "Complete this field in the Dashboard.",
            })),
        })
      const prepared = yield* applyAuthoritativeFormRules(
        step,
        values,
        originals,
        inaccessible,
      )
      yield* checkProviderUserTargets(context, prepared, step, fields)
      if (!inputSchema) {
        const unexpectedFields = Object.keys(prepared)
        if (chat && unexpectedFields.length > 0)
          return yield* new InputValidationError({
            errors: unexpectedFields.map((field) => ({
              field,
              message: "This form has no editable fields.",
            })),
          })
        return {}
      }
      return (yield* Schema.decodeUnknownEffect(
        inputSchema as unknown as Schema.Codec<unknown, unknown, never, never>,
        { errors: "all", ...(chat ? { onExcessProperty: "error" } : {}) },
      )(prepared).pipe(
        Effect.mapError(
          (error) =>
            new InputValidationError({
              errors: extractValidationErrors(error),
            }),
        ),
      )) as ProcessState
    })
    return {
      processStateData,
      fields: fieldsInChat,
      needsDashboard,
      validate,
      hiddenPaths: () =>
        getHiddenRulePaths(
          getEffectiveFormRuleStates(step, values, inaccessible),
        ),
    }
  })

export const inspectTodoForm = (options: {
  readonly todoId: string
  readonly input: ProcessState
  readonly identity: ExecutionIdentity
}) =>
  Effect.gen(function* () {
    const { todoId, input, identity } = options
    yield* authorizeTodo(todoId, { kind: "authenticated", identity })
    const operations = yield* StepCompletionOperations
    const todo = yield* operations.queryTodoById(todoId)
    const { organisation } = yield* OrganisationProvider
    const step = todo ? organisation.formByPath(todo.targetStepPath) : undefined
    if (!todo || !step)
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message: "This To-Do form is not available.",
      })
    const form = yield* prepareTodoForm({
      todo,
      input,
      step,
      inputSchema: step.submissionEffectSchema,
      context: identity,
      chat: true,
    })
    const errors = yield* form.validate.pipe(
      Effect.as([]),
      Effect.catchTag("InputValidationError", (error) =>
        Effect.succeed(error.errors),
      ),
    )
    return {
      stepPath: todo.targetStepPath,
      processName: step.process.props.name,
      stepName: step.props.name ?? step.node.id,
      fields: form.fields,
      needsDashboard: form.needsDashboard,
      errors,
    }
  })

/** Authorize, validate and complete a form To-Do in the normal runtime path. */
export const completeStep = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  todoId: string,
  input: ProcessState,
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  inputSchema: Schema.Top | undefined,
  context: ExecutionIdentity,
  options: CompleteStepOptions = {},
) =>
  Effect.gen(function* () {
    const sqlClient = yield* SqlClient.SqlClient
    const stepCompletionOps = yield* StepCompletionOperations
    const externalParticipantOps = yield* ExternalParticipantOperations
    const queueService = yield* QueueService
    const stepRoleQueries = yield* StepRoleQueries
    const requestTime = yield* getRequestTime()
    const stepPath = normalizePath(step.node.path)
    const userDetails = yield* getUserDetails()
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const calendarQueries = yield* BusinessCalendarQueries
    const providerUserQueries = yield* ProviderUserQueries

    const enqueueEvents = (
      executionId: string,
      processId: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* queueService.enqueue(TODO_EVENT_QUEUE, {
          todoIds: [todoId],
        })
        if (processId) {
          yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
        }
        yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
          executionId,
        })
      })
    const enqueueJobsAndEvents = (
      scheduledFlowId: string,
      executionId: string,
      processId: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, { scheduledFlowId })
        yield* Effect.log(
          queueService.queueInTransaction
            ? "Staged flow (provisional until outer commit)"
            : "Flow scheduled",
          { scheduledFlowId },
        )
        yield* enqueueEvents(executionId, processId)
      })

    let completeStepAttempt = 0
    const completionTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withConcurrentTransaction(
        sqlClient,
        Effect.gen(function* () {
          const txMode = yield* getTransactionMode
          yield* Effect.logInfo("Completing step transaction").pipe(
            Effect.annotateLogs({
              todoId,
              txMode,
              completeStepAttempt,
              completeStepRetryCount: completeStepAttempt - 1,
            }),
          )
          return yield* effect
        }),
      )

    const attempt = Effect.gen(function* () {
      completeStepAttempt += 1
      const completingRolePath = yield* authorizeTodo(
        todoId,
        options.actor ?? { kind: "authenticated", identity: context },
      )
      const externalParticipantId = options.externalParticipantEmail
        ? yield* externalParticipantOps
            .upsertByEmail(options.externalParticipantEmail)
            .pipe(
              Effect.catchTag(
                "InvalidExternalParticipantEmail",
                invalidExternalParticipantEmailError,
              ),
            )
        : undefined
      const completedByRoleId = completingRolePath
        ? yield* stepRoleQueries.queryRoleIdByPath(completingRolePath)
        : undefined
      if (completingRolePath && completedByRoleId === undefined) {
        yield* Effect.logWarning(
          "Completing role not found in DB; completed_by_role_id will be null",
        ).pipe(
          Effect.annotateLogs({
            completingRolePath,
          }),
        )
      }

      const completionIdentity = yield* Effect.gen(function* () {
        if (
          externalParticipantId !== undefined ||
          !userDetails.id ||
          !completedByRoleId ||
          !completingRolePath
        ) {
          return undefined
        }

        const providerUser =
          yield* providerUserQueries.queryProviderUserByUserId(userDetails.id)
        const rolePath = completingRolePath
        const roleName =
          step.props.role &&
          normalizePath(step.props.role.node.path) === rolePath
            ? step.props.role.name
            : (rolePath.split("/").filter(Boolean).at(-1) ?? rolePath)
        return {
          userId: userDetails.id,
          providerUserId: Option.match(providerUser, {
            onNone: () => userDetails.id,
            onSome: (row) => row.id,
          }),
          email: Option.match(providerUser, {
            onNone: () => userDetails.by,
            onSome: (row) => row.email,
          }),
          name: Option.match(providerUser, {
            onNone: () => userDetails.by,
            onSome: (row) => row.name,
          }),
          roleId: completedByRoleId,
          rolePath,
          roleName,
          completedAt: DateTime.formatIso(requestTime),
        }
      })

      const todoInfo =
        yield* stepCompletionOps.queryTodoForCompletionById(todoId)
      if (!todoInfo) {
        return yield* new TodoNotFoundError({ todoId })
      }
      if (todoInfo.targetStepPath !== stepPath) {
        return yield* new TodoStepMismatchError({
          todoId,
          expectedStepPath: stepPath,
          actualStepPath: todoInfo.targetStepPath,
        })
      }
      if (todoInfo.completed) {
        return yield* completionTransaction(
          Effect.gen(function* () {
            const result = yield* stepCompletionOps.completeToDoIfOpen({
              todoId,
              userId:
                externalParticipantId === undefined ? userDetails.id : null,
              businessDurationMs: null,
              externalParticipantId: externalParticipantId ?? null,
              completedByRoleId: completedByRoleId ?? null,
              ...(options.completionFingerprint === undefined
                ? {}
                : { completionFingerprint: options.completionFingerprint }),
            })
            switch (result.kind) {
              case "already-completed":
                return {
                  kind: "already-completed" as const,
                  executionId: todoInfo.processExecutionId,
                }
              case "conflict":
                if (options.completionFingerprint !== undefined)
                  return yield* new StepCompletionConflictError({ todoId })
                return yield* new RetryStepCompletion({
                  reason: "todo-conflict",
                })
              case "not-found":
                return yield* new TodoNotFoundError({ todoId })
              case "completed":
                return yield* new RetryStepCompletion({
                  reason: "state-conflict",
                })
            }
          }),
        )
      }

      const form = yield* prepareTodoForm({
        todo: todoInfo,
        input,
        step,
        inputSchema,
        context,
        chat: options.completionFingerprint !== undefined,
      })
      const { processStateData } = form
      const validatedInput = yield* form.validate
      const persistedCompletionInput = structuredClone(validatedInput)
      for (const path of form.hiddenPaths()) {
        setPathDeleteMarker(persistedCompletionInput, path)
      }

      const forEachStepKey = todoInfo.hasForEach
        ? toCamelCase(getStepIdFromPath(stepPath))
        : null
      const businessDurationMs = yield* calculateStepBusinessDuration(
        calendarQueries,
        todoInfo.createdAtMs,
        DateTime.toEpochMillis(requestTime),
        todoInfo.orgUnitId,
      )

      const completionIdentityPatch = completionIdentity
        ? {
            _completionIdentity: {
              [stepPath]: completionIdentity,
            },
          }
        : undefined
      const statePatch = {
        ...persistedCompletionInput,
        ...completionIdentityPatch,
      }

      return yield* completionTransaction(
        Effect.gen(function* () {
          if (!forEachStepKey && Object.keys(statePatch).length > 0) {
            if (!processStateData) {
              return yield* new RetryStepCompletion({
                reason: "state-conflict",
              })
            }
            const stateUpdate =
              yield* stepCompletionOps.updateProcessStateIfUnchanged(
                todoInfo.processStateId,
                processStateData.updatedAt,
                statePatch,
              )
            if (stateUpdate.kind === "conflict") {
              return yield* new RetryStepCompletion({
                reason: "state-conflict",
              })
            }
          }

          const todoCompletion = yield* stepCompletionOps.completeToDoIfOpen({
            todoId,
            userId: externalParticipantId === undefined ? userDetails.id : null,
            businessDurationMs,
            externalParticipantId: externalParticipantId ?? null,
            completedByRoleId: completedByRoleId ?? null,
            ...(options.completionFingerprint === undefined
              ? {}
              : { completionFingerprint: options.completionFingerprint }),
          })
          switch (todoCompletion.kind) {
            case "already-completed":
              return yield* new ReplayStepCompletion({
                executionId: todoInfo.processExecutionId,
              })
            case "conflict":
              return yield* new RetryStepCompletion({
                reason: "todo-conflict",
              })
            case "not-found":
              return yield* new TodoNotFoundError({ todoId })
            case "completed":
              break
          }

          yield* scheduledFlowOps.disarmTaskDeadlines(todoId)

          if (forEachStepKey) {
            if (!processStateData) {
              return yield* new RetryStepCompletion({
                reason: "state-conflict",
              })
            }
            const append =
              yield* stepCompletionOps.appendProcessStateArrayItemIfUnchanged(
                todoInfo.processStateId,
                processStateData.updatedAt,
                forEachStepKey,
                persistedCompletionInput,
              )
            if (append.kind === "conflict") {
              return yield* new RetryStepCompletion({
                reason: "state-conflict",
              })
            }
            if (completionIdentityPatch) {
              const identityUpdate =
                yield* stepCompletionOps.updateProcessStateIfUnchanged(
                  todoInfo.processStateId,
                  append.updatedAt,
                  completionIdentityPatch,
                )
              if (identityUpdate.kind === "conflict") {
                return yield* new RetryStepCompletion({
                  reason: "state-conflict",
                })
              }
            }
          }

          yield* executeFormSubmission(step, validatedInput)

          const scheduledFlowId = todoInfo.barrierScheduledFlowId
            ? todoInfo.barrierScheduledFlowId
            : yield* scheduledFlowOps.insertOrGetScheduledFlow(
                todoId,
                todoInfo.processExecutionId,
                todoInfo.targetStepId,
                {
                  ...(completedByRoleId !== undefined
                    ? { completedByRoleId }
                    : {}),
                },
              )
          const processId = yield* flowExecutionOps.getProcessIdForExecution(
            todoInfo.processExecutionId,
          )

          if (queueService.queueInTransaction) {
            yield* enqueueJobsAndEvents(
              scheduledFlowId,
              todoInfo.processExecutionId,
              processId ?? undefined,
            )
          } else {
            yield* flowExecutionOps.insertFlowDispatchJobs(
              externalCompletionDispatchJobs({
                todoId,
                processExecutionId: todoInfo.processExecutionId,
                processId: processId ?? undefined,
                scheduledFlowId,
              }),
            )
          }

          return {
            kind: "completed" as const,
            executionId: todoInfo.processExecutionId,
            scheduledFlowId,
            processId: processId ?? undefined,
          }
        }),
      ).pipe(
        Effect.catchTag("ReplayStepCompletion", () =>
          Effect.succeed({
            kind: "already-completed" as const,
            executionId: todoInfo.processExecutionId,
          }),
        ),
      )
    })

    const result = yield* attempt.pipe(
      Effect.retry({
        schedule: COMPLETE_STEP_RETRY_SCHEDULE,
        while: isRetryableStepCompletionError,
      }),
      Effect.catch((error) =>
        Effect.fail(
          isRetryableStepCompletionError(error)
            ? new StepCompletionConflictError({ todoId })
            : error,
        ),
      ),
    )

    if (result.kind === "completed") {
      if (
        options.source === "public" ||
        options.externalParticipantEmail !== undefined
      ) {
        yield* recordSuccessfulExternalAction("todo_completion")
      }
      yield* recordSuccessfulStepCompletion(
        options.externalParticipantEmail
          ? "human"
          : processStartTriggerForSession(context.session),
      )
    }

    if (!queueService.queueInTransaction) {
      yield* recoverExternalCompletionEnqueue(todoId)
    }

    return {
      executionId: result.executionId,
      stepPath,
      timestamp: DateTime.formatIso(requestTime),
    }
  })
