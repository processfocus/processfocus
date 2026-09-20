import { SqlClient } from "@effect/sql"
import { type Job, QueueService } from "@processfocus/runtime"
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  FiberRef,
  Metric,
  Option,
  Schema,
} from "effect"
import {
  type BusinessCalendarConfig,
  type BusinessCalendarError,
  type BusinessCalendarServiceShape,
  calculateBusinessDuration,
  makeBusinessCalendarService,
} from "@pf/business-calendar"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  type FlowWithCondition,
  NOTIFICATION_DELIVERY_QUEUE,
  type NewFlowDispatchJob,
  type NotificationRecipientRow,
  type OrgUnitCalendarData,
  PROCESS_EVENT_QUEUE,
  ProviderUserQueries,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
  UserDetails,
  buildCalendarConfig,
  decodeDelegationAudit,
  hasCalendarConfigured,
  withUserDetailsScope,
} from "@pf/graphql-db-operations"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  buildPublicTodoUrl,
  encryptPublicTodoToken,
} from "@pf/graphql-schema"
import {
  type BusinessDaysSchedule,
  type BusinessHoursSchedule,
  type BusinessMinutesSchedule,
  ConditionEvaluator,
  type FlowContext,
  ForEachItemsResolver,
  type Form,
  type FromPointSchedule,
  OrganisationProvider,
  Schedule,
  ScheduleEvaluator,
  type ScheduledTime,
  type StepMeta,
  buildFlowContext,
} from "@pf/process"
import { getRequestTime } from "@pf/request-time"
import {
  DirectAssigneeResolutionError,
  InvalidProcessStateError,
  InvalidScheduleMarkerError,
  InvalidSlaUnitError,
  ProcessStateNotFoundError,
  RetryBudgetExceededError,
  ScheduledFlowNotFoundError,
} from "../errors"
import { NotificationDeliveryConfig } from "../services/notification-delivery-config"
import type { NotificationDeliveryPayload } from "./notification-delivery"
import { selectMatchingOnErrorFlows } from "./on-error-routing"

// Re-export for backward compatibility
export { FLOW_EXECUTION_QUEUE }

// Metric for tracking scheduled flows
const flowsScheduled = Metric.counter("flows.scheduled", {
  description: "Number of flows scheduled (todos created)",
})

// Metric for tracking deferred flows
const flowsDeferred = Metric.counter("flows.deferred", {
  description: "Number of flows deferred for later execution",
})

/**
 * Schema for flow-execution queue job payloads.
 *
 * The payload only contains the scheduledFlowId. The job handler looks up
 * processExecutionId and sourceStepId from the scheduled_flow table.
 * This is part of a 2-phase commit pattern between the database and job queue.
 */
export const FlowExecutionPayloadSchema = Schema.Struct({
  scheduledFlowId: Schema.String,
  onError: Schema.optional(Schema.Boolean),
  errorTag: Schema.optional(Schema.String),
})

export type FlowExecutionPayload = typeof FlowExecutionPayloadSchema.Type

/**
 * Schema for validating process state as a record.
 */
const ProcessStateSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

/**
 * Fall back to clock time for business-time markers.
 * Used when no calendar is configured or calendar config is invalid.
 *
 * Uses Math.floor to avoid scheduling further in the future than expected
 * (e.g., 1.4999 hours becomes 89 minutes, not 90).
 */
const resolveBusinessTimeAsClockTime = (
  scheduledTime:
    | BusinessMinutesSchedule
    | BusinessHoursSchedule
    | BusinessDaysSchedule
    | FromPointSchedule,
): DateTime.DateTime => {
  switch (scheduledTime._tag) {
    case "BusinessMinutes":
      // Treat business minutes as regular minutes
      return DateTime.add(scheduledTime.from, {
        minutes: Math.floor(scheduledTime.minutes),
      })
    case "BusinessHours":
      // Treat business hours as regular hours
      return DateTime.add(scheduledTime.from, {
        minutes: Math.floor(scheduledTime.hours * 60),
      })
    case "BusinessDays":
      // Treat business days as 24-hour days
      return DateTime.add(scheduledTime.from, {
        hours: Math.floor(scheduledTime.days * 24),
      })
    case "FromPoint":
      // Fallback: treat as calendar offset (no business day snapping when no calendar configured)
      return DateTime.add(scheduledTime.from, scheduledTime.offset)
  }
}

/**
 * Resolve a FromPointSchedule marker.
 *
 * 1. Compute target: DateTime.add(marker.from, marker.offset)
 * 2. Determine direction: target < from → backward, else forward
 * 3. If isBusinessDay(target) → use target, else snap via previousBusinessDay(target) (backward) or nextBusinessDay(target) (forward)
 * 4. Snap to businessDayStart(resolvedDay)
 *
 * Fallback (no calendar): return DateTime.add(marker.from, marker.offset) as-is
 */
const resolveFromPointSchedule = (
  marker: {
    _tag: "FromPoint"
    from: DateTime.DateTime
    offset: { days?: number; hours?: number; minutes?: number }
  },
  calendarData: OrgUnitCalendarData | undefined,
): Effect.Effect<
  DateTime.DateTime,
  InvalidScheduleMarkerError | BusinessCalendarError,
  never
> =>
  Effect.gen(function* () {
    // Validate marker has required fields
    if (!marker.from || !marker.offset) {
      return yield* new InvalidScheduleMarkerError({
        marker,
        reason: "Missing required fields: from date or offset",
      })
    }

    // Compute the target datetime by applying the offset
    const target = DateTime.add(marker.from, marker.offset)

    // Check if we have a calendar configured
    if (!calendarData || !hasCalendarConfigured(calendarData)) {
      yield* Effect.logDebug(
        "No calendar configured, falling back to clock time for FromPoint schedule",
      )
      return target
    }

    // Build calendar service and resolve using business calendar
    return yield* buildCalendarConfig(calendarData).pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          const calendarService = yield* makeBusinessCalendarService(config)
          const targetUtc = DateTime.toUtc(target)
          const fromUtc = DateTime.toUtc(marker.from)

          // Determine direction based on offset sign (negative = backward, positive = forward)
          const isBackward = DateTime.lessThan(targetUtc, fromUtc)

          // Check if target is a business day
          const isBusinessDay = yield* calendarService.isBusinessDay(targetUtc)

          let resolvedDay: DateTime.Utc
          if (isBusinessDay) {
            resolvedDay = targetUtc
          } else if (isBackward) {
            // Snap backward to previous business day
            resolvedDay = yield* calendarService.previousBusinessDay(targetUtc)
          } else {
            // Snap forward to next business day
            resolvedDay = yield* calendarService.nextBusinessDay(targetUtc)
          }

          // Snap to start of business day
          const startOpt = yield* calendarService.businessDayStart(resolvedDay)
          if (Option.isSome(startOpt)) {
            return startOpt.value
          }

          // Fallback: return the resolved day at midnight if no business hours
          return resolvedDay
        }),
      ),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "Invalid calendar config, falling back to clock time for FromPoint schedule",
            { error },
          )
          return target
        }),
      ),
    )
  })

/**
 * Resolve a ScheduledTime to a DateTime.DateTime.
 *
 * If the ScheduledTime is already a DateTime, return it as-is.
 * If it's a business-time marker (BusinessHoursSchedule or BusinessDaysSchedule),
 * resolve it using the BusinessCalendarService.
 * If it's a ClockTimeSchedule, use DateTime.add.
 *
 * When no calendar is configured, business-time markers fall back to clock time.
 *
 * @param scheduledTime - The ScheduledTime from the schedule function
 * @param calendarData - Optional calendar data for the org unit
 * @returns The resolved DateTime.DateTime
 */
const resolveScheduledTime = (
  scheduledTime: ScheduledTime,
  calendarData: OrgUnitCalendarData | undefined,
): Effect.Effect<
  DateTime.DateTime,
  InvalidScheduleMarkerError | BusinessCalendarError,
  never
> =>
  Effect.gen(function* () {
    // If it's already a DateTime, return as-is
    if (!Schedule.isScheduleMarker(scheduledTime)) {
      return scheduledTime
    }

    // Use pattern matching for schedule marker types
    return yield* Schedule.match(scheduledTime, {
      // ClockTimeSchedule - no calendar needed
      onClockTime: (marker) =>
        Effect.succeed(
          DateTime.add(marker.from, {
            millis: Duration.toMillis(marker.duration),
          }),
        ),

      // BusinessMinutesSchedule - use calendar (convert to hours) or fall back to clock time
      onBusinessMinutes: (marker) =>
        resolveBusinessTimeMarker(
          marker,
          calendarData,
          (svc) =>
            svc.addBusinessHours(
              DateTime.toUtc(marker.from),
              marker.minutes / 60,
            ),
          () => resolveBusinessTimeAsClockTime(marker),
        ),

      // BusinessHoursSchedule - use calendar or fall back to clock time
      onBusinessHours: (marker) =>
        resolveBusinessTimeMarker(
          marker,
          calendarData,
          (svc) =>
            svc.addBusinessHours(DateTime.toUtc(marker.from), marker.hours),
          () => resolveBusinessTimeAsClockTime(marker),
        ),

      // BusinessDaysSchedule - use calendar or fall back to clock time
      onBusinessDays: (marker) =>
        resolveBusinessTimeMarker(
          marker,
          calendarData,
          (svc) =>
            svc.addBusinessDays(DateTime.toUtc(marker.from), marker.days),
          () => resolveBusinessTimeAsClockTime(marker),
        ),

      // FromPointSchedule - compute calendar offset and snap to business day
      onFromPoint: (marker) => resolveFromPointSchedule(marker, calendarData),
    })
  })

/**
 * Resolve a business-time marker using the calendar service, with fallback.
 */
const resolveBusinessTimeMarker = <T extends { _tag: string }>(
  marker: T,
  calendarData: OrgUnitCalendarData | undefined,
  resolve: (
    svc: BusinessCalendarServiceShape,
  ) => Effect.Effect<DateTime.DateTime, BusinessCalendarError, never>,
  fallback: () => DateTime.DateTime,
): Effect.Effect<DateTime.DateTime, BusinessCalendarError, never> =>
  Effect.gen(function* () {
    // Check if we have a calendar configured
    if (!calendarData || !hasCalendarConfigured(calendarData)) {
      yield* Effect.logDebug(
        "No calendar configured, falling back to clock time for business schedule",
        { tag: marker._tag },
      )
      return fallback()
    }

    // Build calendar service and resolve using business calendar
    // Fall back to clock time if calendar config is invalid
    return yield* buildCalendarConfig(calendarData).pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          const calendarService = yield* makeBusinessCalendarService(config)
          return yield* resolve(calendarService)
        }),
      ),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "Invalid calendar config, falling back to clock time for business schedule",
            { error },
          )
          return fallback()
        }),
      ),
    )
  })

/**
 * Parameters for enqueueing flow execution jobs.
 */
interface EnqueueJobsParams {
  readonly todoIds: readonly string[]
  readonly notificationDeliveryPayloads: readonly NotificationDeliveryPayload[]
  readonly systemStepTodos: ReadonlyArray<{
    readonly todoId: string
    readonly stepPath: string
  }>
  readonly deferredFlows: ReadonlyArray<{
    readonly flow: FlowWithCondition
    readonly scheduledAt: DateTime.DateTime
  }>
  readonly processWasFinished: boolean
  readonly processExecutionId: string
  readonly sourceStepId: string
  readonly now: DateTime.DateTime
}

const formatNotificationRecipientDisplayName = (
  recipient: NotificationRecipientRow,
): string | undefined => {
  const fullName = recipient.name.trim()

  if (fullName.length > 0) {
    return fullName
  }

  const fallbackName = `${recipient.firstName} ${recipient.lastName}`.trim()
  return fallbackName.length > 0 ? fallbackName : undefined
}

const resolveDirectRecipient = ({
  providerUserId,
  directRecipientCache,
  flowExecutionOps,
}: {
  providerUserId: string
  directRecipientCache: Map<string, NotificationRecipientRow | null>
  flowExecutionOps: FlowExecutionOperations["Type"]
}) => {
  const cachedRecipient = directRecipientCache.get(providerUserId)

  if (cachedRecipient !== undefined) {
    return Effect.succeed(cachedRecipient === null ? [] : [cachedRecipient])
  }

  return flowExecutionOps
    .queryNotificationRecipientByProviderUserId(providerUserId)
    .pipe(
      Effect.tap((recipient) =>
        Effect.sync(() => directRecipientCache.set(providerUserId, recipient)),
      ),
      Effect.map((recipient) => (recipient === null ? [] : [recipient])),
    )
}

const resolveRoleRecipients = ({
  roleId,
  roleRecipientCache,
  flowExecutionOps,
}: {
  roleId: string
  roleRecipientCache: Map<string, readonly NotificationRecipientRow[]>
  flowExecutionOps: FlowExecutionOperations["Type"]
}) => {
  const cachedRecipients = roleRecipientCache.get(roleId)

  if (cachedRecipients !== undefined) {
    return Effect.succeed(cachedRecipients)
  }

  // TODO: Batch role recipient lookups if high-fanout flows start creating
  // todos for many distinct roles in one run.
  return flowExecutionOps
    .queryNotificationRecipientsByRoleId(roleId)
    .pipe(
      Effect.tap((recipients) =>
        Effect.sync(() => roleRecipientCache.set(roleId, recipients)),
      ),
    )
}

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

const preparePublicCompletionPayloadWithAttempt = (todoInfo: {
  readonly todoId: string
  readonly processExecutionId: string
  readonly stepPath: string
  readonly processName: string
  readonly stepName: string
  readonly itemData: Record<string, unknown> | unknown[] | null
}) =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    if (Option.isNone(organisationProvider)) {
      return undefined
    }

    const { organisation } = organisationProvider.value
    const step = organisation.stepByPath(todoInfo.stepPath)

    if (!step?.isForm) {
      return undefined
    }

    const form = step as unknown as Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields,
      string,
      unknown,
      boolean
    >
    const publicCompletion = form.publicCompletion

    if (!publicCompletion) {
      return undefined
    }

    const flowExecutionOps = yield* FlowExecutionOperations
    const stepCompletionOps = yield* StepCompletionOperations
    const notificationConfig = yield* NotificationDeliveryConfig
    const processStateRaw =
      yield* flowExecutionOps.getProcessStateByExecutionId(
        todoInfo.processExecutionId,
      )
    if (!processStateRaw) {
      return yield* new ProcessStateNotFoundError({
        processExecutionId: todoInfo.processExecutionId,
      })
    }

    const state = yield* Schema.decodeUnknown(ProcessStateSchema)(
      processStateRaw.state ?? {},
    ).pipe(
      Effect.mapError(
        () =>
          new InvalidProcessStateError({
            processExecutionId: todoInfo.processExecutionId,
            reason: "State is not a valid record",
          }),
      ),
    )
    const completedSteps =
      yield* stepCompletionOps.getCompletedStepsForExecution(
        todoInfo.processExecutionId,
      )
    const processStartedAt =
      completedSteps.length > 0
        ? completedSteps.reduce((earliest, step) =>
            DateTime.lessThan(step.completedAt, earliest.completedAt)
              ? step
              : earliest,
          ).completedAt
        : yield* DateTime.now
    const ctx = buildFlowContext(
      todoInfo.processExecutionId,
      processStartedAt,
      completedSteps,
    )
    const item = todoInfo.itemData ?? undefined

    const recipient = normalizePublicRecipient(
      yield* resolveMaybeEffect(publicCompletion.recipient(state, ctx, item)),
    )
    const expiresAt = yield* resolveMaybeEffect(
      publicCompletion.expiresAt(state, ctx, item),
    )
    const publicCompletionInvitationAttemptId =
      yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
        todoId: todoInfo.todoId,
        recipientEmail: recipient.email,
      })
    const issuedAtSeconds = Math.floor(Date.now() / 1000)
    const expiresAtIso = DateTime.formatIso(expiresAt)
    const expiresAtSeconds = Math.floor(
      DateTime.toEpochMillis(expiresAt) / 1000,
    )
    const token = yield* encryptPublicTodoToken({
      v: 1,
      tid: todoInfo.todoId,
      externalParticipantEmail: recipient.email,
      publicCompletionInvitationAttemptId,
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
      aud: PUBLIC_TODO_TOKEN_AUDIENCE,
    })
    const publicUrl = buildPublicTodoUrl(
      notificationConfig.getFrontendBaseUrl(),
      token,
    )
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

    return {
      channel: "email" as const,
      recipient,
      publicTodo: {
        todoId: todoInfo.todoId,
        processName: todoInfo.processName,
        stepName: todoInfo.stepName,
        token,
        expiresAt: expiresAtIso,
        publicCompletionInvitationAttemptId,
        ...(publicCompletion.from !== undefined && {
          from: publicCompletion.from,
        }),
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body }),
        ...(template !== undefined && { template }),
        ...(attachments !== undefined && { attachments }),
      },
    } satisfies NotificationDeliveryPayload
  })

const shouldAlwaysNotifyTodoAssignment = (stepPath: string) =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    if (Option.isNone(organisationProvider)) {
      yield* Effect.logWarning(
        "Could not resolve organisation for todo notification settings",
        { stepPath },
      )
      return false
    }

    const step = organisationProvider.value.organisation.stepByPath(stepPath)
    if (!step) {
      yield* Effect.logWarning(
        "Could not resolve step for todo notification settings",
        { stepPath },
      )
      return false
    }

    return step.props.alwaysNotify === true
  })

const resolveNotificationDeliveryPayloads = (todoIds: readonly string[]) =>
  Effect.gen(function* () {
    if (todoIds.length === 0) {
      return []
    }

    const flowExecutionOps = yield* FlowExecutionOperations
    const todoInfos = yield* flowExecutionOps.queryTodoNotificationInfo(todoIds)
    const payloads: NotificationDeliveryPayload[] = []
    const directRecipientCache = new Map<
      string,
      NotificationRecipientRow | null
    >()
    const roleRecipientCache = new Map<
      string,
      readonly NotificationRecipientRow[]
    >()

    for (const todoInfo of todoInfos) {
      // System steps (NodeStep) have no roleId, so there are no human recipients.
      if (todoInfo.roleId === null) {
        continue
      }

      const publicCompletionPayload =
        yield* preparePublicCompletionPayloadWithAttempt(todoInfo)
      if (publicCompletionPayload) {
        payloads.push(publicCompletionPayload)
        yield* Effect.log(
          "Skipped internal todo assignment notifications for public-completion todo",
          {
            todoId: todoInfo.todoId,
            stepPath: todoInfo.stepPath,
            processName: todoInfo.processName,
            stepName: todoInfo.stepName,
          },
        )
        continue
      }

      const alwaysNotify = yield* shouldAlwaysNotifyTodoAssignment(
        todoInfo.stepPath,
      )
      const directAssigneePresent = todoInfo.assignedToProviderUserId !== null
      const candidateRecipients = yield* directAssigneePresent
        ? resolveDirectRecipient({
            providerUserId: todoInfo.assignedToProviderUserId,
            directRecipientCache,
            flowExecutionOps,
          })
        : resolveRoleRecipients({
            roleId: todoInfo.roleId,
            roleRecipientCache,
            flowExecutionOps,
          })

      const eligibleRecipients = alwaysNotify
        ? candidateRecipients
        : candidateRecipients.filter(
            (recipient) => recipient.todoAssignmentEmailEnabled,
          )
      const dedupedRecipients = [
        ...new Map(
          eligibleRecipients.map((recipient) => [recipient.userId, recipient]),
        ).values(),
      ]

      if (dedupedRecipients.length === 0) {
        yield* Effect.log(
          "Created todo produced zero notification-delivery jobs",
          {
            todoId: todoInfo.todoId,
            stepPath: todoInfo.stepPath,
            processName: todoInfo.processName,
            stepName: todoInfo.stepName,
            roleId: todoInfo.roleId,
            assignedToProviderUserId: todoInfo.assignedToProviderUserId,
            recipientResolution: directAssigneePresent ? "direct" : "role",
            candidateCount: candidateRecipients.length,
            eligibleRecipientCount: eligibleRecipients.length,
            dedupedRecipientCount: 0,
            roleFanoutSuppressed: directAssigneePresent,
            alwaysNotify,
          },
        )
        continue
      }

      for (const recipient of dedupedRecipients) {
        const displayName = formatNotificationRecipientDisplayName(recipient)
        const payload: NotificationDeliveryPayload = {
          channel: "email",
          recipient: {
            userId: recipient.userId,
            email: recipient.email,
            ...(displayName ? { displayName } : {}),
          },
          todo: {
            todoId: todoInfo.todoId,
            stepPath: todoInfo.stepPath,
            processName: todoInfo.processName,
            stepName: todoInfo.stepName,
          },
        }

        payloads.push(payload)
      }

      yield* Effect.log("Prepared notification-delivery jobs", {
        todoId: todoInfo.todoId,
        recipientResolution: directAssigneePresent ? "direct" : "role",
        alwaysNotify,
        recipientCount: dedupedRecipients.length,
        duplicateRecipientCount:
          eligibleRecipients.length - dedupedRecipients.length,
      })
    }

    return payloads
  })

const enqueueNotificationDeliveryJobs = (
  payloads: readonly NotificationDeliveryPayload[],
) =>
  Effect.gen(function* () {
    if (payloads.length === 0) {
      return
    }

    const queueService = yield* QueueService
    for (const payload of payloads) {
      yield* queueService.enqueue(NOTIFICATION_DELIVERY_QUEUE, payload)
    }
  })

type AssigneeResolutionContext = {
  readonly state: Record<string, unknown>
  readonly ctx: FlowContext<Record<string, StepMeta>>
}

const resolveProviderUserId = (stepPath: string, assignee: string) =>
  Effect.gen(function* () {
    const providerUserQueries = yield* ProviderUserQueries
    const trimmed = assignee.trim()
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new DirectAssigneeResolutionError({
          stepPath,
          assignee,
          message: `Direct assignee for step "${stepPath}" resolved to an empty value`,
        }),
      )
    }

    const result = trimmed.includes("@")
      ? yield* providerUserQueries.queryProviderUserByEmail(trimmed)
      : yield* providerUserQueries.queryProviderUserByProviderUserId(trimmed)

    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(
          new DirectAssigneeResolutionError({
            stepPath,
            assignee: trimmed,
            message: `Could not resolve direct assignee "${trimmed}" for step "${stepPath}"`,
          }),
        ),
      onSome: (providerUser) => Effect.succeed(providerUser.id),
    })
  })

const resolveTodoAssignee = ({
  stepPath,
  state,
  ctx,
  item,
}: {
  readonly stepPath: string
  readonly state: Record<string, unknown>
  readonly ctx: FlowContext<Record<string, StepMeta>>
  readonly item?: Record<string, unknown> | unknown[]
}) =>
  Effect.gen(function* () {
    const organisationProvider = yield* OrganisationProvider
    const step = organisationProvider.organisation.stepByPath(stepPath)
    if (!step?.isForm) {
      return undefined
    }

    const form = step as unknown as Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields,
      string,
      Record<string, unknown> | unknown[] | undefined,
      boolean
    >

    if (!form.hasAssigneeFunction) {
      return undefined
    }

    const assignee = yield* form.getAssignee(state, ctx, item)
    if (assignee === undefined) {
      return undefined
    }

    return yield* resolveProviderUserId(stepPath, assignee)
  })

const targetStepHasAssignee = (stepPath: string) =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    if (Option.isNone(organisationProvider)) {
      return false
    }

    const step = organisationProvider.value.organisation.stepByPath(stepPath)
    if (!step?.isForm) {
      return false
    }

    return (step as unknown as Form).hasAssigneeFunction
  })

/**
 * Enqueues all jobs resulting from flow execution.
 * This includes todo-event, system-step-execution, deferred flow jobs,
 * and process/execution event jobs.
 *
 * Called either inside the transaction (for DB-backed queues) or
 * after the transaction (for external queues like SQS).
 */
const enqueueFlowExecutionJobs = (params: EnqueueJobsParams) =>
  Effect.gen(function* () {
    const {
      todoIds,
      notificationDeliveryPayloads,
      systemStepTodos,
      deferredFlows,
      processWasFinished,
      processExecutionId,
      sourceStepId,
      now,
    } = params

    const queueService = yield* QueueService
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations

    // Enqueue todo-event job
    if (todoIds.length > 0) {
      yield* queueService.enqueue(TODO_EVENT_QUEUE, { todoIds })
      yield* Effect.log("Enqueued todo-event job", {
        todoCount: todoIds.length,
      })

      yield* enqueueNotificationDeliveryJobs(notificationDeliveryPayloads)
    }

    // Enqueue system-step-execution jobs for system steps
    for (const { todoId, stepPath } of systemStepTodos) {
      // Look up step retry limit from database (set during org hydration from step.retries)
      const retryLimit =
        yield* flowExecutionOps.getStepRetryLimitByPath(stepPath)

      yield* queueService.enqueue(
        SYSTEM_STEP_EXECUTION_QUEUE,
        { todoId, stepPath },
        retryLimit !== null ? { retryLimit } : undefined,
      )
      yield* Effect.log("Enqueued system-step-execution job", {
        todoId,
        stepPath,
        retryLimit: retryLimit ?? "default",
      })
    }

    // Handle deferred flows - create new scheduled_flow records and enqueue jobs
    for (const { flow, scheduledAt } of deferredFlows) {
      // Convert scheduledAt to UTC for database storage
      const scheduledAtUtc = DateTime.toUtc(scheduledAt)

      // Create a new scheduled_flow record with targetStepId and scheduledAt
      const newScheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
        processExecutionId,
        sourceStepId,
        {
          targetStepId: flow.targetStepId,
          scheduledAt: scheduledAtUtc,
        },
      )

      // Calculate delay and enqueue job
      const delay = DateTime.distanceDuration(now, scheduledAt)
      yield* queueService.enqueueWithDelay(
        FLOW_EXECUTION_QUEUE,
        { scheduledFlowId: newScheduledFlowId },
        delay,
      )

      yield* Effect.log("Deferred flow scheduled", {
        flowId: flow.id,
        newScheduledFlowId,
        scheduledAt: DateTime.formatIso(scheduledAt),
        delayMs: Duration.toMillis(delay),
      })
    }

    // Enqueue process and execution events
    // Only if something actually changed (todos created or process finished)
    const stateChanged = todoIds.length > 0 || processWasFinished

    if (stateChanged) {
      const processId =
        yield* flowExecutionOps.getProcessIdForExecution(processExecutionId)

      if (processId) {
        yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
        yield* Effect.log("Enqueued process-event job", { processId })
      }

      yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
        executionId: processExecutionId,
      })
      yield* Effect.log("Enqueued execution-event job", {
        executionId: processExecutionId,
      })
    }
  })

const notificationLogicalId = (
  sourceScheduledFlowId: string,
  payload: NotificationDeliveryPayload,
) => {
  const todoId =
    "todo" in payload
      ? payload.todo.todoId
      : "publicTodo" in payload
        ? payload.publicTodo.todoId
        : "correctionRequired" in payload
          ? payload.correctionRequired.todoId
          : "executionFailure" in payload
            ? payload.executionFailure.executionId
            : (payload.accessReviewControl.todoId ??
              payload.accessReviewControl.executionId ??
              payload.accessReviewControl.failureCategory)
  const recipientId =
    payload.recipient.userId ??
    ("publicTodo" in payload
      ? payload.publicTodo.publicCompletionInvitationAttemptId
      : payload.recipient.email)
  return `${sourceScheduledFlowId}:notification:${todoId}:${recipientId}`
}

const persistExternalFlowDispatch = ({
  params,
  passThroughFlowIds,
  sourceScheduledFlowId,
}: {
  readonly params: EnqueueJobsParams
  readonly passThroughFlowIds: readonly string[]
  readonly sourceScheduledFlowId: string
}) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const jobs: NewFlowDispatchJob[] = []
    let sequence = 0
    const add = (
      logicalJobId: string,
      queue: string,
      payload: Record<string, unknown>,
      options?: { readonly retryLimit?: number; readonly scheduledAt?: string },
    ) => {
      jobs.push({
        sourceScheduledFlowId,
        logicalJobId,
        queue,
        payload,
        retryLimit: options?.retryLimit ?? null,
        scheduledAt: options?.scheduledAt ?? null,
        sequence: sequence++,
      })
    }

    if (params.todoIds.length > 0) {
      add(`${sourceScheduledFlowId}:todo-event`, TODO_EVENT_QUEUE, {
        todoIds: [...params.todoIds],
      })
      for (const payload of params.notificationDeliveryPayloads) {
        add(
          notificationLogicalId(sourceScheduledFlowId, payload),
          NOTIFICATION_DELIVERY_QUEUE,
          payload,
        )
      }
    }

    for (const { todoId, stepPath } of params.systemStepTodos) {
      const retryLimit =
        yield* flowExecutionOps.getStepRetryLimitByPath(stepPath)
      add(
        `${sourceScheduledFlowId}:system-step:${todoId}`,
        SYSTEM_STEP_EXECUTION_QUEUE,
        { todoId, stepPath },
        retryLimit === null ? undefined : { retryLimit },
      )
    }

    for (const { flow, scheduledAt } of params.deferredFlows) {
      const deferredScheduledFlowId =
        yield* scheduledFlowOps.insertScheduledFlow(
          params.processExecutionId,
          params.sourceStepId,
          {
            targetStepId: flow.targetStepId,
            scheduledAt: DateTime.toUtc(scheduledAt),
          },
        )
      add(
        `${sourceScheduledFlowId}:deferred-flow:${flow.id}`,
        FLOW_EXECUTION_QUEUE,
        { scheduledFlowId: deferredScheduledFlowId },
        { scheduledAt: DateTime.formatIso(scheduledAt) },
      )
    }

    const stateChanged = params.todoIds.length > 0 || params.processWasFinished
    if (stateChanged) {
      const processId = yield* flowExecutionOps.getProcessIdForExecution(
        params.processExecutionId,
      )
      if (processId) {
        add(`${sourceScheduledFlowId}:process-event`, PROCESS_EVENT_QUEUE, {
          processId,
        })
      }
      add(`${sourceScheduledFlowId}:execution-event`, EXECUTION_EVENT_QUEUE, {
        executionId: params.processExecutionId,
      })
    }

    for (const passThroughFlowId of passThroughFlowIds) {
      add(
        `${sourceScheduledFlowId}:pass-through:${passThroughFlowId}`,
        FLOW_EXECUTION_QUEUE,
        { scheduledFlowId: passThroughFlowId },
      )
    }

    yield* flowExecutionOps.insertFlowDispatchJobs(jobs)
  })

const drainExternalFlowDispatch = (sourceScheduledFlowId: string) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const jobs = yield* flowExecutionOps.queryFlowDispatchJobs(
      sourceScheduledFlowId,
    )

    for (const job of jobs) {
      const options = {
        logicalJobId: job.logicalJobId,
        ...(job.retryLimit === null ? {} : { retryLimit: job.retryLimit }),
      }
      if (job.scheduledAt === null) {
        yield* queueService.enqueue(job.queue, job.payload, options)
      } else {
        const now = yield* DateTime.now
        const scheduledAt = DateTime.unsafeMake(job.scheduledAt)
        const delay = DateTime.lessThanOrEqualTo(scheduledAt, now)
          ? Duration.zero
          : DateTime.distanceDuration(now, scheduledAt)
        yield* queueService.enqueueWithDelay(
          job.queue,
          job.payload,
          delay,
          options,
        )
      }
      yield* flowExecutionOps.deleteFlowDispatchJob(job.id)
    }

    return jobs.length
  })

/**
 * Record a flow-execution failure on the last attempt when an infrastructure
 * error escapes the inner handler.
 *
 * Flow-execution doesn't have a todoId, so we can't call failToDo(). Instead
 * we clean up the scheduled_flow, mark the execution as finished (via
 * setProcessExecutionFinished), and enqueue events so the frontend updates.
 * The execution shows as "Completed" rather than stuck in "Running" forever.
 */
const recordFlowExecutionFailure = (
  job: Job<FlowExecutionPayload>,
  errorDescription: string,
) =>
  Effect.gen(function* () {
    const { scheduledFlowId } = job.payload
    const completedJobOps = yield* CompletedJobOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const calendarQueries = yield* BusinessCalendarQueries
    const queueService = yield* QueueService
    const sqlClient = yield* SqlClient.SqlClient

    yield* Effect.logError(
      "Infrastructure error on last attempt of flow-execution, cleaning up",
      {
        scheduledFlowId,
        jobId: job.jobId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: errorDescription,
      },
    )

    const cleanupResult = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        // Look up the scheduled_flow to get processExecutionId
        const scheduledFlowOption =
          yield* scheduledFlowOps.getScheduledFlow(scheduledFlowId)

        if (Option.isNone(scheduledFlowOption)) {
          // Scheduled flow already gone — just mark job completed
          yield* completedJobOps.markJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )
          return { shouldPublish: false, processExecutionId: null }
        }

        const { processExecutionId } = scheduledFlowOption.value

        // Atomically claim the scheduled_flow before cleanup.
        const claimed =
          yield* scheduledFlowOps.deleteScheduledFlow(scheduledFlowId)
        if (!claimed) {
          yield* completedJobOps.markJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )
          return { shouldPublish: false, processExecutionId: null }
        }

        const executionOpen =
          yield* flowExecutionOps.isProcessExecutionOpen(processExecutionId)
        if (!executionOpen) {
          yield* completedJobOps.markJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )
          return { shouldPublish: false, processExecutionId: null }
        }

        // Mark job as completed (prevents dead-letter)
        yield* completedJobOps.markJobCompleted(FLOW_EXECUTION_QUEUE, job.jobId)

        // Mark the execution as finished so it doesn't stay in "Running" forever
        yield* checkAndMarkProcessFinished(
          flowExecutionOps,
          calendarQueries,
          processExecutionId,
          queueService.queueInTransaction,
        )

        return { shouldPublish: true, processExecutionId }
      }),
    )

    if (!cleanupResult.shouldPublish || !cleanupResult.processExecutionId) {
      return
    }

    // Enqueue events so the frontend updates
    const processId = yield* flowExecutionOps.getProcessIdForExecution(
      cleanupResult.processExecutionId,
    )
    if (processId) {
      yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
    }
    yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
      executionId: cleanupResult.processExecutionId,
    })
  })

const describeFlowExecutionError = (error: unknown): string => {
  if (error instanceof DirectAssigneeResolutionError) {
    return `${error.message}; unresolved direct assignee=${error.assignee}; stepPath=${error.stepPath}`
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}

/**
 * Handler for flow-execution queue jobs.
 *
 * When a process starts or a step completes, a single flow-execution job is
 * enqueued to evaluate and execute all outgoing flows from the source step.
 *
 * This handler uses a 2-phase commit pattern with idempotency:
 * 1. Check if job was already completed (idempotency check)
 * 2. Look up the scheduled_flow record by ID
 * 3. If not found and attempts < maxAttempts: throw ScheduledFlowNotFoundError (will retry)
 * 4. If not found and attempts >= maxAttempts: log warning and skip (spurious job)
 * 5. If found: delete scheduled_flow, process flows, publish todo events, and mark job
 *    completed - all in a single transaction
 *
 * The markJobCompleted happens inside the transaction to ensure crash-safety:
 * if we crash after commit but before job acknowledgment, retries will skip
 * because the job is already marked as completed.
 *
 * An outer wrapper catches infrastructure errors on the last attempt and cleans
 * up the execution so it doesn't stay stuck in "Running" forever.
 */
const handleFlowExecution = Effect.fn("flow-execution")(
  (job: Job<FlowExecutionPayload>) =>
    handleFlowExecutionInner(job).pipe(
      Effect.catchAll((error) => {
        if (job.attempts < job.maxAttempts) return Effect.fail(error)
        return Effect.gen(function* () {
          const flowExecutionOps = yield* FlowExecutionOperations
          const pending = yield* flowExecutionOps.queryFlowDispatchJobs(
            job.payload.scheduledFlowId,
          )
          if (pending.length > 0) return yield* Effect.fail(error)

          const description = `Exhausted ${job.maxAttempts} retries: ${describeFlowExecutionError(error)}`
          return yield* recordFlowExecutionFailure(job, description).pipe(
            Effect.catchAllCause((recordingCause) =>
              Effect.logError(
                "Failed to record flow-execution infrastructure failure",
                {
                  scheduledFlowId: job.payload.scheduledFlowId,
                  recordingError: Cause.pretty(recordingCause),
                },
              ),
            ),
          )
        })
      }),
      Effect.catchAllDefect((defect) => {
        if (job.attempts < job.maxAttempts) return Effect.die(defect)

        const description = `Exhausted ${job.maxAttempts} retries (defect): ${String(defect)}`
        return recordFlowExecutionFailure(job, description).pipe(
          Effect.catchAllCause((recordingCause) =>
            Effect.logError(
              "Failed to record flow-execution infrastructure defect",
              {
                scheduledFlowId: job.payload.scheduledFlowId,
                recordingError: Cause.pretty(recordingCause),
              },
            ),
          ),
        )
      }),
    ),
)

/**
 * Inner handler for flow-execution. Extracted so the outer handler
 * can wrap it with last-attempt failure recording.
 */
const handleFlowExecutionInner = (job: Job<FlowExecutionPayload>) =>
  Effect.gen(function* () {
    const { errorTag, onError, scheduledFlowId } = job.payload

    const queueService = yield* QueueService
    if (!queueService.queueInTransaction) {
      const resumedCount = yield* drainExternalFlowDispatch(scheduledFlowId)
      if (resumedCount > 0) {
        yield* Effect.log("Resumed external flow dispatch", {
          scheduledFlowId,
          dispatchedJobs: resumedCount,
        })
        return
      }
    }

    // Guard: if we've exceeded the retry budget, fail immediately regardless
    // of whether the flow would succeed.
    //
    // NOTE: This is primarily an SQS concern. SQS's per-message maxAttempts is
    // advisory only; the queue's redrive policy is the hard enforcement and
    // may deliver beyond our intended limit. Database queues (SQLite/Postgres)
    // handle retry limits correctly in their claim queries (jobAttempts < jobRetryLimit),
    // but we include this guard for defense-in-depth and consistent behavior.
    if (job.attempts > job.maxAttempts) {
      return yield* new RetryBudgetExceededError({
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        queue: FLOW_EXECUTION_QUEUE,
      })
    }

    const completedJobOps = yield* CompletedJobOperations
    const scheduledFlowOps = yield* ScheduledFlowOperations
    const flowExecutionOps = yield* FlowExecutionOperations
    const calendarQueries = yield* BusinessCalendarQueries
    const conditionEvaluator = yield* ConditionEvaluator
    const scheduleEvaluator = yield* ScheduleEvaluator
    const sqlClient = yield* SqlClient.SqlClient

    const alreadyCompleted = yield* completedJobOps.isJobCompleted(
      FLOW_EXECUTION_QUEUE,
      job.jobId,
    )

    const scheduledFlowOption =
      yield* scheduledFlowOps.getScheduledFlow(scheduledFlowId)
    const staleBarrierCompletion =
      alreadyCompleted &&
      Option.isSome(scheduledFlowOption) &&
      scheduledFlowOption.value.forEachBarrier

    if (alreadyCompleted && !staleBarrierCompletion) {
      yield* Effect.log("Job already completed, skipping", {
        jobId: job.jobId,
        scheduledFlowId,
      })
      return
    }
    if (staleBarrierCompletion) {
      yield* Effect.logWarning(
        "Rechecking live forEach barrier with stale completion marker",
        { jobId: job.jobId, scheduledFlowId },
      )
    }

    // Handle not found case (2-phase commit pattern)
    if (Option.isNone(scheduledFlowOption)) {
      // Check if this was a forEach barrier that was already claimed by
      // another handler. When multiple forEach todos complete concurrently,
      // each enqueues a flow-execution job with the same barrier
      // scheduledFlowId. The first handler to see all siblings done claims
      // the barrier via DELETE ... RETURNING; subsequent handlers find it
      // gone. We detect this by checking if any todo references this ID as
      // its barrierScheduledFlowId.
      const wasBarrier =
        yield* scheduledFlowOps.wasBarrierScheduledFlow(scheduledFlowId)

      if (wasBarrier) {
        yield* Effect.log("Barrier scheduled flow already claimed, skipping", {
          scheduledFlowId,
        })
        return
      }

      if (job.attempts < job.maxAttempts) {
        // Record not visible yet - throw error to trigger retry
        return yield* new ScheduledFlowNotFoundError({ scheduledFlowId })
      }
      // Max retries reached - this is a spurious job (transaction was rolled back)
      yield* Effect.logWarning(
        "Scheduled flow not found after max retries, skipping as spurious job",
        {
          scheduledFlowId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        },
      )
      return
    }

    const {
      processExecutionId,
      sourceStepId,
      targetStepId: storedTargetStepId,
      forEachBarrier,
    } = scheduledFlowOption.value

    // Accepted work survives logout/expiry. Recover attribution only, never
    // authorization or a login credential, from the durable handoff.
    const initiatingAudit = scheduledFlowOption.value.createdBy
    if (initiatingAudit !== undefined) {
      const actor = decodeDelegationAudit(initiatingAudit)
      if (Option.isSome(actor)) {
        const userDetails = yield* UserDetails
        yield* FiberRef.set(userDetails, {
          by: initiatingAudit,
          id: actor.value.ownerUserId,
        })
      }
    }

    // forEach barrier check: if this is a barrier scheduled_flow, verify
    // all sibling todos for the step are complete before proceeding.
    // Each forEach todo completion enqueues a flow-execution job referencing
    // the same barrier scheduledFlowId. Only the last one to see all siblings
    // done should proceed; the rest skip via atomic DELETE ... RETURNING.
    //
    // TOCTOU note: there is an intentional race between the
    // countActiveTodosForStep check and the DELETE below. Under Postgres
    // READ COMMITTED, two handlers can both see activeSiblings === 0
    // concurrently. This is safe because the subsequent DELETE ...
    // RETURNING is atomic — exactly one handler's DELETE will return a
    // row (claimed = true) and proceed; the other gets claimed = false
    // and skips. The count check is an optimistic fast-path to avoid
    // unnecessary DELETE attempts while siblings are still active.
    if (forEachBarrier) {
      const activeSiblings = yield* flowExecutionOps.countActiveTodosForStep(
        processExecutionId,
        sourceStepId,
      )

      yield* Effect.log("forEach barrier check", {
        scheduledFlowId,
        sourceStepId,
        activeSiblings,
      })

      if (activeSiblings > 0) {
        // Siblings still active — leave the barrier scheduled_flow in place
        // and leave the logical job uncompleted so a later sibling's delivery
        // with the same deterministic job ID can pick it up.
        return
      }

      // All siblings done. The transaction below atomically claims the barrier
      // and checks the execution is still open before proceeding.
    }

    // Get current time once for consistency
    const now = yield* DateTime.now

    // Note: AWS delayed delivery is handled by EventBridge Scheduler via the
    // queue-delay bridge Lambda. The scheduledAt field is still used for
    // business-time calculations.

    yield* Effect.log("Executing flows for process from source step", {
      sourceStepId,
      processExecutionId,
      scheduledFlowId,
      targetStepId: storedTargetStepId,
    })

    const makeSkippedTransactionResult = () => ({
      todoIds: [],
      notificationDeliveryPayloads: [],
      deferredFlows: [],
      systemStepTodos: [],
      processWasFinished: false,
      passThroughFlowIds: [],
    })

    // All database operations in a single transaction
    const transactionResult = yield* sqlClient.withTransaction(
      Effect.gen(function* () {
        // Delete the scheduled_flow record to ensure idempotency.
        const claimed =
          yield* scheduledFlowOps.deleteScheduledFlow(scheduledFlowId)

        if (!claimed) {
          yield* Effect.log(
            forEachBarrier
              ? "forEach barrier already claimed by another handler, skipping"
              : "Scheduled flow already claimed or cancelled, skipping",
            { scheduledFlowId },
          )
          if (!staleBarrierCompletion) {
            yield* completedJobOps.markJobCompleted(
              FLOW_EXECUTION_QUEUE,
              job.jobId,
            )
          }
          return makeSkippedTransactionResult()
        }

        if (staleBarrierCompletion) {
          yield* completedJobOps.clearJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )
        }

        if (forEachBarrier) {
          yield* Effect.log("forEach barrier claimed, proceeding with flow", {
            scheduledFlowId,
            sourceStepId,
          })
        }

        const executionOpen =
          yield* flowExecutionOps.isProcessExecutionOpen(processExecutionId)
        if (!executionOpen) {
          yield* Effect.log("Process execution is closed, skipping flow", {
            processExecutionId,
            scheduledFlowId,
          })
          yield* completedJobOps.markJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )
          return makeSkippedTransactionResult()
        }

        // 1. Query all flows from source step
        const allFlows =
          yield* flowExecutionOps.queryFlowsBySourceStepId(sourceStepId)

        // Add step info to the current span
        const sourceStepPath = allFlows[0]?.sourceStepPath
        yield* Effect.annotateCurrentSpan("step.id", sourceStepId)
        if (sourceStepPath) {
          yield* Effect.annotateCurrentSpan("step.path", sourceStepPath)
        }

        // Filter flows if this job targets a specific flow (storedTargetStepId is set)
        // This happens for deferred scheduled flows
        const filteredFlows = storedTargetStepId
          ? allFlows.filter((f) => f.targetStepId === storedTargetStepId)
          : allFlows
        const flows = onError
          ? selectMatchingOnErrorFlows(filteredFlows, errorTag)
          : filteredFlows.filter((flow) => !flow.isOnError)

        if (flows.length === 0) {
          yield* Effect.log("No outgoing flows from source step", {
            sourceStepId,
            targetStepId: storedTargetStepId,
            onError: onError ?? false,
            errorTag,
          })
          // Check if process should be marked as finished
          const processWasFinished = yield* checkAndMarkProcessFinished(
            flowExecutionOps,
            calendarQueries,
            processExecutionId,
            queueService.queueInTransaction,
          )
          // Mark job as completed before returning
          yield* completedJobOps.markJobCompleted(
            FLOW_EXECUTION_QUEUE,
            job.jobId,
          )

          // For DB-backed queues, enqueue events inside the transaction
          if (queueService.queueInTransaction) {
            yield* enqueueFlowExecutionJobs({
              todoIds: [],
              notificationDeliveryPayloads: [],
              systemStepTodos: [],
              deferredFlows: [],
              processWasFinished,
              processExecutionId,
              sourceStepId,
              now,
            })
          } else {
            yield* persistExternalFlowDispatch({
              sourceScheduledFlowId: scheduledFlowId,
              passThroughFlowIds: [],
              params: {
                todoIds: [],
                notificationDeliveryPayloads: [],
                systemStepTodos: [],
                deferredFlows: [],
                processWasFinished,
                processExecutionId,
                sourceStepId,
                now,
              },
            })
          }

          return {
            todoIds: [],
            notificationDeliveryPayloads: [],
            deferredFlows: [],
            systemStepTodos: [],
            processWasFinished,
          }
        }

        yield* Effect.log("Found outgoing flows", {
          sourceStepId,
          flowCount: flows.length,
          targetStepId: storedTargetStepId,
        })

        // Phase 1: Separate flows by type
        const elseBranches: FlowWithCondition[] = []
        const conditionalFlows: FlowWithCondition[] = []
        const scheduledFlows: FlowWithCondition[] = []
        const unconditionalFlows: FlowWithCondition[] = []

        for (const flow of flows) {
          if (flow.fallbackBranch) {
            elseBranches.push(flow)
          } else if (flow.schedule !== null) {
            // Schedule flows are evaluated first, then condition if present
            scheduledFlows.push(flow)
          } else if (flow.condition !== null) {
            conditionalFlows.push(flow)
          } else {
            unconditionalFlows.push(flow)
          }
        }

        yield* Effect.logDebug("Categorized flows", {
          unconditional: unconditionalFlows.length,
          conditional: conditionalFlows.length,
          scheduled: scheduledFlows.length,
          else: elseBranches.length,
        })

        // Phase 2: Always take unconditional flows (they're ready immediately)
        const flowsToExecute: FlowWithCondition[] = [...unconditionalFlows]
        const deferredFlows: Array<{
          flow: FlowWithCondition
          scheduledAt: DateTime.DateTime
        }> = []

        // Helper to load state and context (only when needed)
        const loadStateAndContext = Effect.gen(function* () {
          const stepCompletionOps = yield* StepCompletionOperations
          const processStateRaw =
            yield* flowExecutionOps.getProcessStateByExecutionId(
              processExecutionId,
            )
          if (!processStateRaw) {
            return yield* new ProcessStateNotFoundError({
              processExecutionId,
            })
          }

          const state = yield* Schema.decodeUnknown(ProcessStateSchema)(
            processStateRaw.state ?? {},
          ).pipe(
            Effect.mapError(
              () =>
                new InvalidProcessStateError({
                  processExecutionId,
                  reason: "State is not a valid record",
                }),
            ),
          )

          // Build FlowContext from completed steps
          const completedSteps =
            yield* stepCompletionOps.getCompletedStepsForExecution(
              processExecutionId,
            )
          // Use earliest completed step's time as process start time.
          // When no completed steps found (e.g. system-started process),
          // fall back to current time and empty context.
          const processStartedAt =
            completedSteps.length > 0
              ? completedSteps.reduce((earliest, step) =>
                  DateTime.lessThan(step.completedAt, earliest.completedAt)
                    ? step
                    : earliest,
                ).completedAt
              : yield* DateTime.now
          const ctx = buildFlowContext(
            processExecutionId,
            processStartedAt,
            completedSteps,
          )

          return {
            state,
            ctx,
            withoutWaiting: processStateRaw.withoutWaiting ?? false,
          }
        })

        // Phase 3: Evaluate scheduled flows
        // Schedule determines *when* to evaluate; condition determines *whether* to take
        if (scheduledFlows.length > 0) {
          const { state, ctx, withoutWaiting } = yield* loadStateAndContext

          // Fetch calendar data for schedule resolution
          // Use the root org unit's calendar for process-level scheduling
          const rootOrgUnitId = yield* calendarQueries.getRootOrgUnit()
          const scheduleCalendarData = rootOrgUnitId
            ? (yield* calendarQueries.getCalendarData([rootOrgUnitId])).get(
                rootOrgUnitId,
              )
            : undefined

          for (const flow of scheduledFlows) {
            // Let schedule evaluation errors propagate - failing the job is safer
            // than executing immediately. The job queue will retry transient errors.
            const rawScheduledTime = yield* scheduleEvaluator.evaluate(
              flow.sourceStepPath,
              flow.targetStepPath,
              state,
              ctx,
            )

            // Resolve business-time markers to actual DateTime
            const scheduledAt = yield* resolveScheduledTime(
              rawScheduledTime,
              scheduleCalendarData,
            )

            if (
              !DateTime.isDateTime(scheduledAt) ||
              !Number.isFinite(DateTime.toEpochMillis(scheduledAt))
            ) {
              return yield* new InvalidScheduleMarkerError({
                marker: rawScheduledTime,
                reason: "Schedule did not resolve to a valid date",
              })
            }

            if (
              withoutWaiting ||
              DateTime.lessThanOrEqualTo(scheduledAt, now)
            ) {
              // Schedule is ready - now check condition if present
              if (flow.condition !== null) {
                const conditionResult = yield* conditionEvaluator
                  .evaluate(
                    flow.sourceStepPath,
                    flow.targetStepPath,
                    state,
                    ctx,
                  )
                  .pipe(
                    Effect.catchTag("ConditionEvaluationError", (error) =>
                      Effect.gen(function* () {
                        yield* Effect.logWarning(
                          "Condition evaluation failed for scheduled flow, treating as false",
                          { flowId: flow.id, error: error.error },
                        )
                        return false
                      }),
                    ),
                  )

                if (conditionResult) {
                  yield* Effect.logDebug(
                    "Scheduled flow ready and condition satisfied",
                    { flowId: flow.id },
                  )
                  flowsToExecute.push(flow)
                } else {
                  yield* Effect.logDebug(
                    "Scheduled flow ready but condition not satisfied",
                    { flowId: flow.id },
                  )
                }
              } else {
                // No condition, just schedule - ready to execute
                yield* Effect.logDebug("Scheduled flow ready, proceeding", {
                  flowId: flow.id,
                  scheduledAt,
                })
                flowsToExecute.push(flow)
              }
            } else {
              // Schedule is in the future - defer this flow
              yield* Effect.logDebug("Scheduled flow deferred", {
                flowId: flow.id,
                scheduledAt: DateTime.formatIso(scheduledAt),
              })
              deferredFlows.push({ flow, scheduledAt })
            }
          }
        }

        // Phase 4: Evaluate conditional flows (non-scheduled)
        if (conditionalFlows.length > 0) {
          const { state, ctx } = yield* loadStateAndContext

          for (const flow of conditionalFlows) {
            const conditionResult = yield* conditionEvaluator
              .evaluate(flow.sourceStepPath, flow.targetStepPath, state, ctx)
              .pipe(
                Effect.catchTag("ConditionEvaluationError", (error) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      "Condition evaluation failed for flow, treating as false",
                      { flowId: flow.id, error: error.error },
                    )
                    return false
                  }),
                ),
              )

            if (conditionResult) {
              yield* Effect.logDebug("Flow condition satisfied, proceeding", {
                flowId: flow.id,
              })
              flowsToExecute.push(flow)
            } else {
              yield* Effect.logDebug(
                "Flow condition not satisfied, skipping ToDo creation",
                { flowId: flow.id },
              )
            }
          }
        }

        // Phase 5: If no conditional flows matched, take else branch
        // Note: scheduled flows don't count for else branch evaluation
        if (conditionalFlows.length > 0) {
          const anyConditionalMatched = flowsToExecute.some((f) =>
            conditionalFlows.includes(f),
          )
          if (!anyConditionalMatched && elseBranches.length > 0) {
            yield* Effect.log(
              "No conditional flows matched, taking else branch",
              { elseBranchCount: elseBranches.length },
            )
            flowsToExecute.push(...elseBranches)
          }
        }

        // Phase 6: Create todos for all ready flows
        // Pre-fetch calendar data for SLA calculation (shared across all todos)
        const orgUnitIds = new Set<string>()
        const flowSlaInfoCache = new Map<
          string,
          {
            slaValue: number | null
            slaUnit: string | null
            slaWarning: number | null
            orgUnitId: string
          } | null
        >()

        // Fetch SLA info for all flows that need todos
        for (const flow of flowsToExecute) {
          const slaInfo = yield* flowExecutionOps.getTargetStepSlaInfo(flow.id)
          flowSlaInfoCache.set(flow.id, slaInfo)
          if (slaInfo) {
            orgUnitIds.add(slaInfo.orgUnitId)
          }
        }

        // Fetch calendar data for all org units
        const calendarDataMap =
          orgUnitIds.size > 0
            ? yield* calendarQueries.getCalendarData([...orgUnitIds])
            : new Map<string, OrgUnitCalendarData>()

        // For org units without calendar, fall back to root org unit's calendar
        const orgUnitsNeedingFallback = [...orgUnitIds].filter((id) => {
          const data = calendarDataMap.get(id)
          return !data || !hasCalendarConfigured(data)
        })

        if (orgUnitsNeedingFallback.length > 0) {
          const rootOrgUnitId = yield* calendarQueries.getRootOrgUnit()

          if (rootOrgUnitId && !calendarDataMap.has(rootOrgUnitId)) {
            const rootCalendarData = yield* calendarQueries.getCalendarData([
              rootOrgUnitId,
            ])
            const rootData = rootCalendarData.get(rootOrgUnitId)

            if (rootData && hasCalendarConfigured(rootData)) {
              for (const orgUnitId of orgUnitsNeedingFallback) {
                calendarDataMap.set(orgUnitId, rootData)
              }
            }
          } else if (rootOrgUnitId) {
            const rootData = calendarDataMap.get(rootOrgUnitId)
            if (rootData && hasCalendarConfigured(rootData)) {
              for (const orgUnitId of orgUnitsNeedingFallback) {
                calendarDataMap.set(orgUnitId, rootData)
              }
            }
          }
        }

        const todoIds: string[] = []
        // Track system step todos for enqueueing after transaction
        const systemStepTodos: Array<{
          todoId: string
          stepPath: string
        }> = []
        // Track forEach steps with 0 items — need immediate flow-execution
        // to process downstream edges (including __end__)
        const passThroughFlowIds: string[] = []

        for (const flow of flowsToExecute) {
          // Calculate SLA target and warning times
          const slaInfo = flowSlaInfoCache.get(flow.id)
          let slaTargetAt: DateTime.Utc | null = null
          let slaWarningAt: DateTime.Utc | null = null

          if (slaInfo && slaInfo.slaValue != null && slaInfo.slaUnit != null) {
            // Validate SLA value is positive
            if (slaInfo.slaValue <= 0) {
              yield* Effect.logWarning(
                "Invalid SLA value, skipping calculation",
                {
                  flowId: flow.id,
                  slaValue: slaInfo.slaValue,
                },
              )
            } else {
              const calendarData = calendarDataMap.get(slaInfo.orgUnitId)
              const slaTimes = yield* calculateTodoSlaTimes(
                calendarData,
                slaInfo.slaValue,
                slaInfo.slaUnit,
                slaInfo.slaWarning,
                now, // Use current time as todo start time
                flow.id,
              )
              slaTargetAt = slaTimes.slaTargetAt
              slaWarningAt = slaTimes.slaWarningAt
            }
          }

          // Check if target step uses forEach (multi-instance)
          const hasForEach = yield* flowExecutionOps.targetStepHasForEach(
            flow.id,
          )

          if (hasForEach) {
            // forEach step: resolve items and create N todos
            const forEachResolver = yield* ForEachItemsResolver
            const { state, ctx } = yield* loadStateAndContext

            const items = yield* forEachResolver.resolve(
              flow.targetStepPath,
              state,
              ctx,
            )

            if (items.length === 0) {
              // Empty items → flow continues immediately (no state contribution).
              // Schedule a flow-execution from this step so downstream flows
              // (including __end__) get processed.
              yield* Effect.log(
                "ForEach step has 0 items, scheduling downstream flow",
                { flowId: flow.id, stepPath: flow.targetStepPath },
              )
              const emptyScheduledFlowId =
                yield* scheduledFlowOps.insertScheduledFlow(
                  processExecutionId,
                  flow.targetStepId,
                )
              passThroughFlowIds.push(emptyScheduledFlowId)
              continue
            }

            yield* Effect.log("Creating forEach todos", {
              flowId: flow.id,
              stepPath: flow.targetStepPath,
              itemCount: items.length,
            })

            // Check if this is a system step (no role)
            const hasRole = yield* flowExecutionOps.targetStepHasRole(flow.id)

            // Create barrier scheduled_flow for the forEach step.
            // Each todo completion will enqueue a flow-execution job referencing
            // this barrier. The flow-execution handler will check if all siblings
            // are done before proceeding — atomic DELETE ... RETURNING ensures
            // only one handler wins if multiple complete simultaneously.
            const barrierScheduledFlowId =
              yield* scheduledFlowOps.insertScheduledFlow(
                processExecutionId,
                flow.targetStepId,
                { forEachBarrier: true },
              )

            yield* Effect.log("Created forEach barrier scheduled_flow", {
              barrierScheduledFlowId,
              stepPath: flow.targetStepPath,
            })

            const hasAssignee = yield* targetStepHasAssignee(
              flow.targetStepPath,
            )
            const newTodoIds = hasAssignee
              ? yield* Effect.forEach(
                  items,
                  (item) =>
                    Effect.gen(function* () {
                      const itemData = item as
                        | Record<string, unknown>
                        | unknown[]
                      const assignedToProviderUserId =
                        yield* resolveTodoAssignee({
                          stepPath: flow.targetStepPath,
                          state,
                          ctx,
                          item: itemData,
                        })
                      return yield* flowExecutionOps.insertToDo({
                        processExecutionId,
                        flowId: flow.id,
                        ...(assignedToProviderUserId !== undefined
                          ? { assignedToProviderUserId }
                          : {}),
                        itemData,
                        slaTargetAt,
                        slaWarningAt,
                        barrierScheduledFlowId,
                      })
                    }),
                  { concurrency: 1 },
                )
              : yield* flowExecutionOps.insertToDos({
                  processExecutionId,
                  flowId: flow.id,
                  items: items as ReadonlyArray<Record<string, unknown>>,
                  slaTargetAt,
                  slaWarningAt,
                  barrierScheduledFlowId,
                })
            todoIds.push(...newTodoIds)

            if (hasRole === false) {
              for (const todoId of newTodoIds) {
                systemStepTodos.push({
                  todoId,
                  stepPath: flow.targetStepPath,
                })
              }
            }

            yield* Effect.log("ForEach todos created", {
              flowId: flow.id,
              todoCount: items.length,
              isSystemStep: hasRole === false,
            })
          } else {
            const hasAssignee = yield* targetStepHasAssignee(
              flow.targetStepPath,
            )
            const assignedToProviderUserId = hasAssignee
              ? yield* Effect.gen(function* () {
                  const assigneeContext: AssigneeResolutionContext =
                    yield* loadStateAndContext
                  return yield* resolveTodoAssignee({
                    stepPath: flow.targetStepPath,
                    ...assigneeContext,
                  })
                })
              : undefined
            // Regular (non-forEach) step: create single todo
            const todoId = yield* flowExecutionOps.insertToDo({
              processExecutionId,
              flowId: flow.id,
              ...(assignedToProviderUserId !== undefined
                ? { assignedToProviderUserId }
                : {}),
              slaTargetAt,
              slaWarningAt,
            })
            todoIds.push(todoId)

            // Check if this is a system step (no role)
            const hasRole = yield* flowExecutionOps.targetStepHasRole(flow.id)
            if (hasRole === false) {
              // System step - track for enqueueing after transaction
              systemStepTodos.push({
                todoId,
                stepPath: flow.targetStepPath,
              })
              yield* Effect.log("Flow executed, created ToDo for system step", {
                flowId: flow.id,
                todoId,
                stepPath: flow.targetStepPath,
              })
            } else {
              yield* Effect.log("Flow executed, created ToDo", {
                flowId: flow.id,
                todoId,
                slaTargetAt: slaTargetAt
                  ? DateTime.formatIso(slaTargetAt)
                  : null,
                slaWarningAt: slaWarningAt
                  ? DateTime.formatIso(slaWarningAt)
                  : null,
              })
            }
          }
        }

        // Check if process should be marked as finished
        // (no todos, no deferred, no pass-through forEach flows)
        let processWasFinished = false
        if (
          todoIds.length === 0 &&
          deferredFlows.length === 0 &&
          passThroughFlowIds.length === 0
        ) {
          processWasFinished = yield* checkAndMarkProcessFinished(
            flowExecutionOps,
            calendarQueries,
            processExecutionId,
            queueService.queueInTransaction,
          )
        }

        const notificationDeliveryPayloads =
          yield* resolveNotificationDeliveryPayloads(todoIds)

        // Mark job as completed (idempotency marker) - inside transaction
        yield* completedJobOps.markJobCompleted(FLOW_EXECUTION_QUEUE, job.jobId)

        // For DB-backed queues, enqueue all jobs inside the transaction
        // This ensures atomicity - if transaction rolls back, no jobs are enqueued
        if (queueService.queueInTransaction) {
          yield* enqueueFlowExecutionJobs({
            todoIds,
            notificationDeliveryPayloads,
            systemStepTodos,
            deferredFlows,
            processWasFinished,
            processExecutionId,
            sourceStepId,
            now,
          })

          // Enqueue pass-through flow-execution jobs for empty forEach steps
          for (const scheduledFlowId of passThroughFlowIds) {
            yield* queueService.enqueue(FLOW_EXECUTION_QUEUE, {
              scheduledFlowId,
            })
            yield* Effect.log("Enqueued pass-through flow for empty forEach", {
              scheduledFlowId,
            })
          }
        } else {
          yield* persistExternalFlowDispatch({
            sourceScheduledFlowId: scheduledFlowId,
            passThroughFlowIds,
            params: {
              todoIds,
              notificationDeliveryPayloads,
              systemStepTodos,
              deferredFlows,
              processWasFinished,
              processExecutionId,
              sourceStepId,
              now,
            },
          })
        }

        return {
          todoIds,
          notificationDeliveryPayloads,
          deferredFlows,
          systemStepTodos,
          processWasFinished,
          passThroughFlowIds,
        }
      }),
    )

    const { todoIds: createdTodoIds, deferredFlows: transactionDeferredFlows } =
      transactionResult

    // External follow-ups were persisted transactionally and are removed only
    // after their stable logical identity has been accepted by the queue.
    if (!queueService.queueInTransaction) {
      yield* drainExternalFlowDispatch(scheduledFlowId)
    }

    // Track deferred flows metric
    if (transactionDeferredFlows.length > 0) {
      yield* Metric.incrementBy(flowsDeferred, transactionDeferredFlows.length)
      yield* Effect.annotateCurrentSpan(
        "flows.deferred",
        transactionDeferredFlows.length,
      )
    }

    // Track metrics and add count to span
    yield* Metric.incrementBy(flowsScheduled, createdTodoIds.length)
    yield* Effect.annotateCurrentSpan("flows.scheduled", createdTodoIds.length)

    yield* Effect.log("Completed flow execution for source step", {
      sourceStepId,
      scheduledFlowId,
      todosCreated: createdTodoIds.length,
      flowsDeferred: transactionDeferredFlows.length,
    })
  })

export const flowExecutionHandler = {
  schema: FlowExecutionPayloadSchema,
  handle: (job: Job<FlowExecutionPayload>) =>
    withUserDetailsScope(handleFlowExecution(job)),
}

/**
 * Calculate business duration for a process execution.
 * Returns the duration in milliseconds.
 * If no calendar is configured, falls back to wallclock time.
 */
const calculateExecutionBusinessDuration = (
  calendarQueries: BusinessCalendarQueries["Type"],
  createdAtMs: number,
  finishedAtMs: number,
  orgUnitId: string,
) =>
  Effect.gen(function* () {
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
        finishedAtMs,
      )

      return Duration.toMillis(duration)
    }

    // Fallback: use wallclock time
    return finishedAtMs - createdAtMs
  })

/**
 * Valid SLA time units.
 */
type SlaUnit = "minutes" | "businessHours" | "businessDays" | "businessWeeks"

/**
 * Check if a string is a valid SLA unit.
 */
const isValidSlaUnit = (unit: string): unit is SlaUnit =>
  unit === "minutes" ||
  unit === "businessHours" ||
  unit === "businessDays" ||
  unit === "businessWeeks"

/**
 * Get number of working days per week from calendar config.
 */
const getWorkingDaysPerWeek = (config: BusinessCalendarConfig): number => {
  const workDays = new Set(config.weeklySchedule.map((s) => s.day))
  return workDays.size
}

/**
 * Add business time based on SLA unit.
 */
const addBusinessTime = (
  calendarService: BusinessCalendarServiceShape,
  startedAt: DateTime.Utc,
  value: number,
  unit: SlaUnit,
  workingDaysPerWeek: number,
): Effect.Effect<DateTime.Utc, BusinessCalendarError, never> => {
  switch (unit) {
    case "minutes":
      return calendarService.addBusinessHours(startedAt, value / 60)
    case "businessHours":
      return calendarService.addBusinessHours(startedAt, value)
    case "businessDays":
      return calendarService.addBusinessDays(startedAt, value)
    case "businessWeeks":
      return calendarService.addBusinessDays(
        startedAt,
        value * workingDaysPerWeek,
      )
  }
}

/**
 * Add clock time (for fallback when no calendar is configured).
 * Converts all units to clock time equivalents.
 */
const addClockTime = (
  startedAt: DateTime.Utc,
  value: number,
  unit: SlaUnit,
): DateTime.Utc => {
  switch (unit) {
    case "minutes":
      return DateTime.add(startedAt, { minutes: Math.round(value) })
    case "businessHours":
      // Treat as regular hours when no calendar
      return DateTime.add(startedAt, { minutes: Math.round(value * 60) })
    case "businessDays":
      // Treat as 24-hour days when no calendar
      return DateTime.add(startedAt, { hours: Math.round(value * 24) })
    case "businessWeeks":
      // Treat as 7-day weeks when no calendar
      return DateTime.add(startedAt, { hours: Math.round(value * 7 * 24) })
  }
}

/**
 * Calculate SLA times using a resolved business calendar service shape.
 */
const calculateSlaWithCalendar = (
  calendarService: BusinessCalendarServiceShape,
  startedAt: DateTime.Utc,
  slaValue: number,
  slaUnit: SlaUnit,
  slaWarning: number | null,
  workingDaysPerWeek: number,
): Effect.Effect<
  { slaTargetAt: DateTime.Utc; slaWarningAt: DateTime.Utc | null },
  BusinessCalendarError,
  never
> =>
  Effect.gen(function* () {
    // Calculate SLA target
    const slaTargetAt = yield* addBusinessTime(
      calendarService,
      startedAt,
      slaValue,
      slaUnit,
      workingDaysPerWeek,
    )

    // Calculate warning time if configured
    let slaWarningAt: DateTime.Utc | null = null
    if (slaWarning != null) {
      const warningFraction = slaWarning / 100
      const warningValue = slaValue * warningFraction
      slaWarningAt = yield* addBusinessTime(
        calendarService,
        startedAt,
        warningValue,
        slaUnit,
        workingDaysPerWeek,
      )
    }

    return { slaTargetAt, slaWarningAt }
  })

/**
 * Calculate SLA target and warning times for a todo.
 * Returns null values if no SLA is configured on the step.
 */
const calculateTodoSlaTimes = (
  calendarData: OrgUnitCalendarData | undefined,
  slaValue: number | null,
  slaUnit: string | null,
  slaWarning: number | null,
  startedAt: DateTime.Utc,
  flowId: string,
) =>
  Effect.gen(function* () {
    // No SLA configured on the step
    if (slaValue == null || slaUnit == null) {
      return { slaTargetAt: null, slaWarningAt: null }
    }

    // Validate SLA unit - fail if invalid (data integrity issue)
    if (!isValidSlaUnit(slaUnit)) {
      return yield* new InvalidSlaUnitError({ flowId, slaUnit })
    }
    const unit: SlaUnit = slaUnit

    // When calendar is configured, always use business calendar (even for minutes)
    // When no calendar configured, fall back to clock time (24/7 operation)
    if (!calendarData || !hasCalendarConfigured(calendarData)) {
      // No calendar - use clock time as fallback
      const slaTargetAt = addClockTime(startedAt, slaValue, unit)

      let slaWarningAt: DateTime.Utc | null = null
      if (slaWarning != null) {
        const warningFraction = slaWarning / 100
        const warningValue = slaValue * warningFraction
        slaWarningAt = addClockTime(startedAt, warningValue, unit)
      }

      return { slaTargetAt, slaWarningAt }
    }

    // Build calendar config and service
    const config = yield* buildCalendarConfig(calendarData)
    const calendarService = yield* makeBusinessCalendarService(config)
    const workingDaysPerWeek = getWorkingDaysPerWeek(config)

    // Calculate SLA times with the resolved calendar service
    return yield* calculateSlaWithCalendar(
      calendarService,
      startedAt,
      slaValue,
      unit,
      slaWarning,
      workingDaysPerWeek,
    )
  })

/**
 * Check if process should be marked as finished.
 * Only marks as finished if no active todos or other flow jobs remain. A
 * database-backed queue may still contain its current unacknowledged job.
 *
 * Note: Process and execution events are emitted by the main handler after
 * the transaction completes, so we don't emit them here.
 */
const checkAndMarkProcessFinished = (
  flowExecutionOps: FlowExecutionOperations["Type"],
  calendarQueries: BusinessCalendarQueries["Type"],
  processExecutionId: string,
  queueInTransaction: boolean,
) =>
  Effect.gen(function* () {
    const activeTodos =
      yield* flowExecutionOps.countActiveTodos(processExecutionId)
    const pendingJobs = yield* flowExecutionOps.countPendingFlowJobs(
      processExecutionId,
      FLOW_EXECUTION_QUEUE,
    )

    // A DB queue includes the currently executing job until acknowledgement,
    // while an external queue has no SQL row for the current SQS message.
    const allowedPendingJobs = queueInTransaction ? 1 : 0

    // For a DB-backed queue we allow one pending job because:
    // - When this check runs, our own job hasn't been acknowledged/deleted yet
    // - So pendingJobs will include our own job (count of 1)
    // - If pendingJobs > 1, there are other jobs for this process still pending
    // - In tests that don't insert actual queue jobs, pendingJobs will be 0
    if (activeTodos === 0 && pendingJobs <= allowedPendingJobs) {
      // Calculate business duration before marking finished
      const details =
        yield* flowExecutionOps.getExecutionDetailsForCompletion(
          processExecutionId,
        )

      let businessDurationMs: number | null = null
      if (details) {
        const requestTime = yield* getRequestTime()
        const finishedAtMs = DateTime.toEpochMillis(requestTime)

        businessDurationMs = yield* calculateExecutionBusinessDuration(
          calendarQueries,
          details.createdAtMs,
          finishedAtMs,
          details.orgUnitId,
        )
      }

      yield* flowExecutionOps.setProcessExecutionFinished(
        processExecutionId,
        businessDurationMs,
      )
      yield* Effect.log("Process execution marked as finished", {
        processExecutionId,
        businessDurationMs,
      })
      return true
    }
    return false
  })
