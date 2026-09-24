import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { QueueService } from "@processfocus/runtime"
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
import { AuthorizationService, ProviderUserPrincipal } from "@pf/auth-policy"
import {
  calculateBusinessDuration,
  makeBusinessCalendarService,
} from "@pf/business-calendar"
import {
  getTransactionMode,
  isSqlLockError,
  withConcurrentTransaction,
} from "@pf/db-info"
import {
  FormPermission,
  FormProviderUserInput,
  fieldInputAst,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
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
} from "@pf/graphql-schema"
import {
  type FlowContext,
  type Form,
  FormComponentType,
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
import {
  type ProcessStartTrigger,
  recordSuccessfulExternalAction,
  recordSuccessfulProcessStart,
  recordSuccessfulStepCompletion,
} from "./business-metrics"
import {
  extractValidationErrors,
  getSchemaAnnotationDeep,
  getSubmissionFields,
} from "./resolver-utils"
import {
  isProviderUserSession,
  processStartTriggerForSession,
} from "./session-guards"
import { startFormContext } from "./start-form-context"
import type { UserContext } from "./types"

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
const COMPLETE_STEP_RETRY_SCHEDULE = Schedule.exponential("25 millis", 2).pipe(
  Schedule.intersect(Schedule.recurs(COMPLETE_STEP_MAX_ATTEMPTS - 1)),
  Schedule.jittered,
)

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

export const recoverExternalCompletionEnqueue = (todoId: string) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    if (queueService.queueInTransaction) return

    const flowExecutionOps = yield* FlowExecutionOperations
    const dispatchId = externalCompletionDispatchId(todoId)
    const now = yield* DateTime.now
    const receipt = randomUUID()
    const jobs = yield* flowExecutionOps.claimFlowDispatchJobs(
      dispatchId,
      now,
      DateTime.add(now, { minutes: 5 }),
      receipt,
    )
    yield* Effect.gen(function* () {
      for (const job of jobs) {
        const renewedAt = yield* DateTime.now
        const renewed = yield* flowExecutionOps.extendFlowDispatchClaim(
          dispatchId,
          receipt,
          DateTime.add(renewedAt, { minutes: 5 }),
        )
        if (!renewed) return

        yield* queueService.enqueue(job.queue, job.payload, {
          logicalJobId: job.logicalJobId,
          ...(job.retryLimit === null ? {} : { retryLimit: job.retryLimit }),
        })
        const deleted = yield* flowExecutionOps.deleteFlowDispatchJob(
          job.id,
          receipt,
        )
        if (!deleted) {
          yield* Effect.logWarning(
            "External completion dispatch lease changed after enqueue",
            { dispatchId, jobId: job.id },
          )
          return
        }
      }
    }).pipe(
      Effect.tapError(() =>
        flowExecutionOps.releaseFlowDispatchJobs(dispatchId, receipt),
      ),
    )
  })

export const recoverPendingExternalCompletionEnqueues = Effect.gen(
  function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const now = yield* DateTime.now
    const dispatchIds =
      yield* flowExecutionOps.queryFlowDispatchIdsByStorageQueue(
        EXTERNAL_COMPLETION_OUTBOX_QUEUE,
        now,
        EXTERNAL_COMPLETION_RECOVERY_BATCH_SIZE,
      )
    for (const dispatchId of dispatchIds) {
      const todoId = dispatchId.slice(
        EXTERNAL_COMPLETION_DISPATCH_PREFIX.length,
      )
      yield* recoverExternalCompletionEnqueue(todoId)
    }
    return dispatchIds.length
  },
)

interface StartProcessExecutionOptions {
  readonly onSubmit?: Effect.Effect<void, InputValidationError>
  readonly withoutWaiting?: boolean
  readonly executionId?: string
  readonly enqueueStartSystemStep?: boolean
  readonly externalParticipantEmail?: string
  readonly trigger?: ProcessStartTrigger
  /** Role path that authorized this step completion (resolved to role ID for completed_by_role) */
  readonly completingRolePath?: string
}

interface CompleteStepOptions {
  /** Public capability provenance, including legacy links without participant email. */
  readonly source?: "public"
  readonly externalParticipantEmail?: string
  /** Role path that authorized this step completion (resolved to role ID for completed_by_role) */
  readonly completingRolePath?: string
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

interface RuleProjectionComponent {
  readonly _tag: string
  readonly field?: string
  readonly children?: Record<string, RuleProjectionComponent>
  readonly itemChildren?: Record<string, RuleProjectionComponent>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pathToFieldName = (path: readonly (string | number)[]): string =>
  path.join(".")

const fieldNameToPath = (fieldName: string): readonly (string | number)[] =>
  fieldName.split(".")

const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path)

const getPathValue = (
  value: unknown,
  path: readonly (string | number)[],
): unknown => {
  let current = value
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment)) {
        return undefined
      }
      current = current[segment]
      continue
    }

    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

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

const copyPreservedPathValue = (
  target: unknown,
  source: unknown,
  path: readonly (string | number)[],
): boolean => {
  if (path.length === 0) return false
  const [segment, ...rest] = path
  if (segment === undefined) return false

  if (Array.isArray(target)) {
    if (typeof segment === "number") {
      if (!Array.isArray(source) || segment >= source.length) return false
      if (rest.length === 0) {
        target[segment] = structuredClone(source[segment])
        return true
      }
      return copyPreservedPathValue(target[segment], source[segment], rest)
    }

    if (!Array.isArray(source)) return false
    let copied = false
    for (const [index, item] of target.entries()) {
      const copiedItem = copyPreservedPathValue(item, source[index], path)
      if (!copiedItem) {
        // Keep row cardinality user-submitted for schema validation, but strip
        // disabled leaves from rows with no corresponding preserved value.
        deletePathValue(item, path)
      }
      copied = copiedItem || copied
    }
    return copied
  }

  if (typeof segment === "number" || !isRecord(target) || !isRecord(source)) {
    return false
  }

  if (!Object.hasOwn(source, segment)) return false
  if (rest.length === 0) {
    target[segment] = structuredClone(source[segment])
    return true
  }

  if (!isRecord(target[segment]) && !Array.isArray(target[segment])) {
    target[segment] = Array.isArray(source[segment]) ? [] : {}
  }
  return copyPreservedPathValue(target[segment], source[segment], rest)
}

const setPathDeleteMarker = (
  target: ProcessState,
  path: readonly (string | number)[],
): void => {
  if (path.length === 0) return
  const [segment, ...rest] = path
  // JSON Merge Patch deletes object members, not array indexes. Typed form-rule
  // authoring currently targets fields, so numeric paths remain defensive only.
  if (typeof segment !== "string") return

  if (rest.length === 0) {
    target[segment] = null
    return
  }

  if (!isRecord(target[segment])) {
    target[segment] = {}
  }
  setPathDeleteMarker(target[segment] as ProcessState, rest)
}

const isBlankRequiredValue = (value: unknown): boolean =>
  // `false` and `0` are explicit submitted values, not blank required values.
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim().length === 0) ||
  (Array.isArray(value) && value.length === 0)

const collectStaticRequiredFields = (
  schema: Schema.Schema.Any | undefined,
): Map<string, readonly (string | number)[]> => {
  const ast = schema?.ast
  if (!ast) return new Map()

  const unwrap = (current: SchemaAST.AST): SchemaAST.AST => {
    switch (current._tag) {
      case "Refinement":
      case "Transformation":
        return unwrap(current.from)
      default:
        return current
    }
  }

  const unwrapped = unwrap(ast)
  if (unwrapped._tag !== "TypeLiteral") return new Map()

  const requiredFields = new Map<string, readonly (string | number)[]>()
  const visit = (
    current: SchemaAST.AST,
    path: readonly (string | number)[],
    ancestorsRequired: boolean,
  ) => {
    const currentUnwrapped = unwrap(current)
    // Static required fields are structural for TypeLiteral schemas. Unions and
    // other dynamic shapes remain authoritative through the later schema decode.
    if (currentUnwrapped._tag !== "TypeLiteral") return

    for (const prop of currentUnwrapped.propertySignatures) {
      if (typeof prop.name !== "string") continue
      const nextPath = [...path, prop.name]
      const isRequired = ancestorsRequired && !prop.isOptional
      const child = unwrap(prop.type)
      if (isRequired && child._tag !== "TypeLiteral") {
        requiredFields.set(pathToFieldName(nextPath), nextPath)
      }
      visit(child, nextPath, isRequired)
    }
  }

  visit(unwrapped, [], true)
  return requiredFields
}

const isSameOrAncestorPath = (
  candidate: readonly (string | number)[],
  path: readonly (string | number)[],
): boolean =>
  candidate.length <= path.length &&
  candidate.every((segment, index) => segment === path[index])

const isEffectivelyHidden = (
  states: readonly EffectiveRuleState[],
  path: readonly (string | number)[],
): boolean =>
  states.some(
    (state) => state.hidden === true && isSameOrAncestorPath(state.path, path),
  )

const isEffectivelyDisabled = (
  states: readonly EffectiveRuleState[],
  path: readonly (string | number)[],
): boolean =>
  states.some(
    (state) =>
      state.disabled === true && isSameOrAncestorPath(state.path, path),
  )

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

const submittedComponentTags: ReadonlySet<string> = new Set([
  // Keep this aligned with submitted FormComponentType values from
  // @pf/form-client-representation/types. Deliberate exclusions such as the
  // read-only table component must be revisited when that type becomes editable.
  FormComponentType.Text,
  FormComponentType.TextArea,
  FormComponentType.Number,
  FormComponentType.Date,
  FormComponentType.Email,
  FormComponentType.Phone,
  FormComponentType.ProviderUser,
  FormComponentType.Boolean,
  FormComponentType.Select,
  FormComponentType.Radio,
  FormComponentType.File,
  FormComponentType.Lookup,
  FormComponentType.CalendarSlot,
  FormComponentType.List,
  FormComponentType.Plugin,
])

const collectSubmittedComponentPaths = (
  component: RuleProjectionComponent,
): readonly (readonly (string | number)[])[] => {
  const paths: Array<readonly (string | number)[]> = []
  if (component.field && submittedComponentTags.has(component._tag)) {
    paths.push(fieldNameToPath(component.field))
  }

  const children = component.children ?? component.itemChildren
  if (children) {
    for (const child of Object.values(children)) {
      paths.push(...collectSubmittedComponentPaths(child))
    }
  }

  return paths
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
  preservedValues: ProcessState,
): EffectiveRuleState[] =>
  step.evaluateFormRules(input, preservedValues).targets.map(
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
      ...(entry.state.label === undefined ? {} : { label: entry.state.label }),
    }),
  )

const getHiddenRulePaths = (
  effectiveStates: readonly EffectiveRuleState[],
): readonly (readonly (string | number)[])[] =>
  effectiveStates
    .filter((entry) => entry.hidden === true)
    .map((entry) => entry.path)
    .sort(compareHiddenDeletePaths)

const findRuleProjectionComponent = (
  components: Record<string, RuleProjectionComponent> | undefined,
  path: readonly (string | number)[],
): RuleProjectionComponent | undefined => {
  let current = components
  let component: RuleProjectionComponent | undefined
  for (const segment of path) {
    if (typeof segment !== "string" || current === undefined) return undefined
    component = current[segment]
    current = component?.children ?? component?.itemChildren
  }

  return component
}

const expandSubmittedRuleTargetPaths = (
  components: Record<string, RuleProjectionComponent> | undefined,
  path: readonly (string | number)[],
): readonly (readonly (string | number)[])[] => {
  const component = findRuleProjectionComponent(components, path)
  if (!component) return [path]

  const submittedPaths = collectSubmittedComponentPaths(component)
  return submittedPaths.length === 0
    ? [path]
    : [...submittedPaths, path].sort(compareHiddenDeletePaths)
}

const getRuleProjectionComponents = (
  representation: Record<string, unknown>,
): Record<string, RuleProjectionComponent> => {
  const entries = Object.entries(representation).filter((entry) => {
    const component = entry[1]
    return isRecord(component) && typeof component["_tag"] === "string"
  })
  return Object.fromEntries(entries) as Record<string, RuleProjectionComponent>
}

const getFormRuleProjectionComponents = Effect.fn(
  "ProcessOperations.getFormRuleProjectionComponents",
)((stepPath: string, definition: ReturnType<Form["clientFormDefinition"]>) =>
  definition.pipe(
    Effect.map((form) => getRuleProjectionComponents(form.components)),
    Effect.catchAll((error) =>
      Effect.logWarning("Failed to build form rule projection", {
        error,
        stepPath: normalizePath(stepPath),
      }).pipe(Effect.as(undefined)),
    ),
  ),
)

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
  inputSchema: Schema.Schema.Any | undefined,
  preservedValues: ProcessState = {},
  projectionComponents?: Record<string, RuleProjectionComponent>,
) =>
  Effect.gen(function* () {
    if (step.authoritativeFormRules().length === 0) {
      return input
    }

    const sanitizedInput: ProcessState = structuredClone(input)
    const staticRequired = collectStaticRequiredFields(inputSchema)
    const effectiveStates = getEffectiveFormRuleStates(
      step,
      input,
      preservedValues,
    )
    const validationErrors: Array<{ field: string; message: string }> = []
    const sanitizedDisabledPaths = new Set<string>()

    const flatPath = (
      path: readonly (string | number)[],
    ): readonly (string | number)[] => step.flattenRuleTargetPath(path)

    // Rules can promote optional fields to required, but schema-required fields
    // stay required even when a rule reports `required: false`.
    // Store both nested path (for effective-state checks) and flat path (for data navigation).
    // Static required fields already have flat paths from the flat submission schema.
    const requiredFields = new Map<
      string,
      {
        nested: readonly (string | number)[]
        flat: readonly (string | number)[]
      }
    >()
    for (const [field, path] of staticRequired) {
      requiredFields.set(field, { nested: path, flat: path })
    }
    for (const entry of effectiveStates) {
      if (entry.required === true) {
        const flat = flatPath(entry.path)
        const field = pathToFieldName(flat)
        if (!requiredFields.has(field)) {
          requiredFields.set(field, { nested: entry.path, flat })
        }
      }
    }

    for (const [field, { nested, flat }] of requiredFields) {
      if (isEffectivelyHidden(effectiveStates, nested)) {
        validationErrors.push({
          field,
          message: "Field cannot be required while hidden",
        })
        continue
      }

      if (isEffectivelyDisabled(effectiveStates, nested)) {
        if (!copyPreservedPathValue(sanitizedInput, preservedValues, flat)) {
          deletePathValue(sanitizedInput, flat)
        }
        sanitizedDisabledPaths.add(pathKey(nested))
      }

      if (isBlankRequiredValue(getPathValue(sanitizedInput, flat))) {
        validationErrors.push({ field, message: "Required" })
      }
    }

    for (const entry of effectiveStates) {
      if (
        entry.disabled !== true ||
        isEffectivelyHidden(effectiveStates, entry.path)
      ) {
        continue
      }

      for (const path of expandSubmittedRuleTargetPaths(
        projectionComponents,
        entry.path,
      )) {
        const key = pathKey(path)
        if (sanitizedDisabledPaths.has(key)) continue
        sanitizedDisabledPaths.add(key)

        const flat = flatPath(path)
        if (!copyPreservedPathValue(sanitizedInput, preservedValues, flat)) {
          deletePathValue(sanitizedInput, flat)
        }
      }
    }

    if (validationErrors.length > 0) {
      return yield* new InputValidationError({ errors: validationErrors })
    }

    const hiddenPaths = getHiddenRulePaths(effectiveStates)
    for (const path of hiddenPaths) {
      for (const submittedPath of expandSubmittedRuleTargetPaths(
        projectionComponents,
        path,
      )) {
        deletePathValue(sanitizedInput, flatPath(submittedPath))
      }
    }

    return sanitizedInput
  })

const astMatchesValue = (value: unknown, ast: SchemaAST.AST): boolean => {
  if (Option.isSome(SchemaAST.getAnnotation(ast, FormProviderUserInput))) {
    return typeof value === "string"
  }

  switch (ast._tag) {
    case "StringKeyword":
      return typeof value === "string"
    case "NumberKeyword":
      return typeof value === "number"
    case "BooleanKeyword":
      return typeof value === "boolean"
    case "UndefinedKeyword":
      return value === undefined
    case "Literal":
      return value === (ast as { readonly literal: unknown }).literal
    case "TypeLiteral":
      return (
        isRecord(value) &&
        ast.propertySignatures.every((prop) => {
          if (typeof prop.name !== "string") return true
          if (prop.type._tag !== "Literal") return true
          if (!Object.hasOwn(value, prop.name)) {
            return (
              (prop as { readonly isOptional?: boolean }).isOptional === true
            )
          }
          return value[prop.name] === prop.type.literal
        })
      )
    case "TupleType":
      return Array.isArray(value)
    case "Refinement":
      return astMatchesValue(value, ast.from)
    case "Transformation":
      return astMatchesValue(value, ast.from)
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
  if (Option.isSome(SchemaAST.getAnnotation(ast, FormProviderUserInput))) {
    return [{ fieldName, value }]
  }

  switch (ast._tag) {
    case "TypeLiteral":
      if (!isRecord(value)) return []
      return ast.propertySignatures.flatMap((prop) => {
        if (typeof prop.name !== "string") return []
        return collectProviderUserTargetsFromAst(
          `${fieldName}.${prop.name}`,
          value[prop.name],
          prop.type,
        )
      })
    case "TupleType": {
      if (!Array.isArray(value)) return []
      const fixedTargets = ast.elements.flatMap((element, index) =>
        collectProviderUserTargetsFromAst(
          `${fieldName}.${index}`,
          value[index],
          element.type,
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
              itemType.type,
            ),
          ),
      )
    }
    case "Refinement":
      return collectProviderUserTargetsFromAst(fieldName, value, ast.from)
    case "Transformation":
      return collectProviderUserTargetsFromAst(fieldName, value, ast.from)
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
  context: UserContext | undefined,
): string | undefined =>
  isProviderUserSession(context?.jwt?.properties)
    ? context.jwt.properties.email
    : undefined

const checkRestrictedFieldSubmissions = <
  TState extends Record<string, unknown>,
  TSteps extends Record<string, StepMeta>,
  TInput extends Schema.Struct.Fields,
  TId extends string,
  TItem,
  TIsForEach extends boolean,
>(
  context: UserContext,
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

    if (restrictedFields.length === 0) return

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
        Effect.catchAll((error) =>
          Effect.logWarning("Field authorization check failed", {
            error,
            fieldName: field.fieldName,
            stepPath,
          }).pipe(Effect.as(false)),
        ),
      )

      if (!allowed && Object.hasOwn(input, field.fieldName)) {
        return yield* new NotAuthorized({
          action: "modifyField",
          resource: `${stepPath}/${field.fieldName}`,
          message: `User is not authorized to modify field ${field.fieldName}`,
        })
      }
    }
  })

export const checkProviderUserTargetFields = (
  context: UserContext,
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
  context: UserContext,
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
  calendarQueries: BusinessCalendarQueries["Type"],
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
          yield* Effect.log("Start system step scheduled", {
            processExecutionId: params.executionId,
            stepId: params.stepId,
            stepPath: startStepPath,
          })
        } else {
          const { scheduledFlowId } = params
          if (!scheduledFlowId) {
            // Non-system starts always create a scheduled_flow. Reaching this
            // branch means the caller passed inconsistent start options.
            return yield* Effect.dieMessage(
              "Missing scheduledFlowId for non-system start",
            )
          }

          // Enqueue flow execution job - job payload only contains scheduledFlowId
          // Job handler will look up processExecutionId and sourceStepId from scheduled_flow table
          yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, { scheduledFlowId })
          yield* Effect.log("Flow scheduled", { scheduledFlowId })
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
          return yield* Effect.dieMessage(
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

    const startInTransaction = sqlClient.withTransaction(
      Effect.gen(function* () {
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
      }),
    )

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
  inputSchema: Schema.Schema.Any | undefined,
  step: Form<TState, TSteps, TInput, TId, TItem, TIsForEach>,
  context: UserContext,
  options?: StartProcessExecutionOptions,
) =>
  Effect.gen(function* () {
    yield* checkRestrictedFieldSubmissions(context, startStepPath, input, step)
    const currentProviderUser = currentProviderUserDefault(context)
    const startContext = startFormContext(context) as FlowContext<TSteps>
    const startState = {} as TState
    const startFields = getSubmissionFields(
      step.getFieldsWithState(startState, startContext),
    )
    const preservedStartDefaults = yield* resolveFormFieldDefaults(
      startFields,
      currentProviderUser,
    )
    const projectionComponents = yield* getFormRuleProjectionComponents(
      step.node.path,
      step.clientFormDefinitionWithState(startState, startContext),
    )
    const defaultedInput = mergeFormDefaults(preservedStartDefaults, input)
    const ruleValidatedInput = yield* applyAuthoritativeFormRules(
      step,
      defaultedInput,
      inputSchema,
      preservedStartDefaults,
      projectionComponents,
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
      validatedInput = (yield* Schema.decodeUnknown(
        inputSchema as unknown as Schema.Schema<unknown, unknown, never>,
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
        trigger: processStartTriggerForSession(context.jwt?.properties),
        // Upsert still normalizes defensively because public completions and
        // direct callers may not have gone through this embedded-form boundary.
        ...(normalizedExternalParticipantEmail
          ? { externalParticipantEmail: normalizedExternalParticipantEmail }
          : {}),
      },
    )
  })

/**
 * Completes a step (form todo), validating input against schema first.
 * This is the extracted logic from the complete mutation resolver,
 * without the authorization check.
 *
 * For forms with read-only fields, resolves defaults from the current process state
 * and merges them with the submitted input before validation.
 */
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
  inputSchema: Schema.Schema.Any | undefined,
  context: UserContext,
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
    const currentProviderUser = currentProviderUserDefault(context)
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
        yield* Effect.log("Flow scheduled", { scheduledFlowId })
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
      const completedByRoleId = options.completingRolePath
        ? yield* stepRoleQueries.queryRoleIdByPath(options.completingRolePath)
        : undefined
      if (options.completingRolePath && completedByRoleId === undefined) {
        yield* Effect.logWarning(
          "Completing role not found in DB; completed_by_role_id will be null",
        ).pipe(
          Effect.annotateLogs({
            completingRolePath: options.completingRolePath,
          }),
        )
      }

      const completionIdentity = yield* Effect.gen(function* () {
        if (
          externalParticipantId !== undefined ||
          !userDetails.id ||
          !completedByRoleId ||
          !options.completingRolePath
        ) {
          return undefined
        }

        const providerUser =
          yield* providerUserQueries.queryProviderUserByUserId(userDetails.id)
        const rolePath = options.completingRolePath
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
            })
            switch (result.kind) {
              case "already-completed":
                return {
                  kind: "already-completed" as const,
                  executionId: todoInfo.processExecutionId,
                }
              case "conflict":
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

      const processStateData =
        yield* stepCompletionOps.getProcessStateByTodoId(todoId)
      const completedSteps = processStateData
        ? yield* stepCompletionOps.getCompletedStepsForExecution(
            processStateData.processExecutionId,
          )
        : []
      const ctx = buildFlowContext(
        processStateData?.processExecutionId ?? todoInfo.processExecutionId,
        processStateData?.processStartedAt ?? requestTime,
        completedSteps,
      )
      const processState = processStateData?.state ?? {}
      const resolvedSubmissionFields = getSubmissionFields(
        step.getFieldsWithState(
          processState as TState,
          ctx as FlowContext<TSteps>,
          (todoInfo.itemData ?? undefined) as TItem,
        ),
      )

      yield* checkRestrictedFieldSubmissions(
        context,
        stepPath,
        input,
        step,
        resolvedSubmissionFields,
      )
      const preservedCompletionDefaults = yield* resolveFormFieldDefaults(
        resolvedSubmissionFields,
        currentProviderUser,
      )
      const preservedValues = mergeFormDefaults(
        preservedCompletionDefaults,
        processState,
      )
      const projectionComponents = yield* getFormRuleProjectionComponents(
        step.node.path,
        step.clientFormDefinitionWithState(
          processState,
          ctx as FlowContext<TSteps>,
          todoInfo.itemData ?? undefined,
        ),
      )
      const defaultedInput = mergeFormDefaults(
        preservedCompletionDefaults,
        input,
      )
      const ruleValidatedInput = yield* applyAuthoritativeFormRules(
        step,
        defaultedInput,
        inputSchema,
        preservedValues,
        projectionComponents,
      )
      yield* checkProviderUserTargets(
        context,
        ruleValidatedInput,
        step,
        resolvedSubmissionFields,
      )

      let validatedInput: ProcessState = {}
      if (inputSchema && input) {
        validatedInput = (yield* Schema.decodeUnknown(
          inputSchema as unknown as Schema.Schema<unknown, unknown, never>,
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
      const persistedCompletionInput = structuredClone(validatedInput)
      for (const path of getHiddenRulePaths(
        getEffectiveFormRuleStates(step, defaultedInput, preservedValues),
      )) {
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
      Effect.catchAll((error) =>
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
          : processStartTriggerForSession(context.jwt?.properties),
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
