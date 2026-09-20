import { SqlClient } from "@effect/sql"
import {
  type PublicCompletionDeliveryCallback,
  QueueService,
} from "@processfocus/runtime"
import { Effect, Option } from "effect"
import {
  EXECUTION_EVENT_QUEUE,
  FlowExecutionOperations,
  NOTIFICATION_DELIVERY_QUEUE,
  type NewFlowDispatchJob,
  type NotificationRecipientRow,
  PROCESS_EVENT_QUEUE,
  type PublicCompletionInvitationAttemptCallbackTarget,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
} from "@pf/graphql-db-operations"
import { OrganisationProvider } from "@pf/process"
import { resolveExecutionFailureNotificationPayloads } from "./execution-failure-notifications"
import type { NotificationDeliveryPayload } from "./notification-delivery"

export type { PublicCompletionDeliveryCallback } from "@processfocus/runtime"

// "Ignored" means no failure follow-up work was enqueued. In the rare
// concurrently-resolved branch, provider delivery metadata may still be stored.
export type PublicCompletionDeliveryCallbackResult =
  | { readonly _tag: "Ignored" }
  | { readonly _tag: "Delivered" }
  | { readonly _tag: "CorrectionRequired" }
  | { readonly _tag: "Failed" }

type PublicCompletionDeliveryCallbackInternalResult =
  | PublicCompletionDeliveryCallbackResult
  | { readonly _tag: "DeliveryRecordedTodoNotFailed" }
  | { readonly _tag: "DeliveryRecordedTodoNotCorrected" }

interface PublicCompletionCorrectionConfigShape {
  readonly enabled?: unknown
}

interface PublicCompletionConfigShape {
  readonly correction?: PublicCompletionCorrectionConfigShape
}

interface PublicCompletionStepShape {
  readonly isForm?: boolean
  readonly publicCompletion?: PublicCompletionConfigShape
}

const formatFailureReason = (
  callback: Extract<
    PublicCompletionDeliveryCallback,
    { readonly status: "failed" }
  >,
) => {
  const details = Object.entries(callback.failureDetails ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")
  const reason =
    details.length > 0
      ? `${callback.failureReason} (${details})`
      : callback.failureReason

  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason
}

const enqueueTodoProcessExecutionEvents = (params: {
  readonly todoId: string
  readonly processExecutionId: string
}) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    const flowExecutionOps = yield* FlowExecutionOperations

    yield* queueService.enqueue(TODO_EVENT_QUEUE, { todoIds: [params.todoId] })

    const processId = yield* flowExecutionOps.getProcessIdForExecution(
      params.processExecutionId,
    )
    if (processId) {
      yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
    }

    yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
      executionId: params.processExecutionId,
    })
  })

const callbackDispatchId = (
  callback: Extract<PublicCompletionDeliveryCallback, { status: "failed" }>,
  result: "correction" | "failed",
) =>
  `public-completion:${callback.invitationAttemptId}:${callback.deliveryId}:${result}`

const notificationLogicalId = (
  dispatchId: string,
  payload: NotificationDeliveryPayload,
) =>
  `${dispatchId}:notification:${payload.recipient.userId ?? payload.recipient.email.trim().toLowerCase()}`

const persistExternalDispatch = (params: {
  readonly dispatchId: string
  readonly todoId: string
  readonly processExecutionId: string
  readonly notificationPayloads: readonly NotificationDeliveryPayload[]
}) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const jobs: NewFlowDispatchJob[] = []
    let sequence = 0
    const add = (
      logicalJobId: string,
      queue: string,
      payload: Record<string, unknown>,
    ) => {
      jobs.push({
        sourceScheduledFlowId: params.dispatchId,
        logicalJobId,
        queue,
        payload,
        retryLimit: null,
        scheduledAt: null,
        sequence: sequence++,
      })
    }

    add(`${params.dispatchId}:todo-event`, TODO_EVENT_QUEUE, {
      todoIds: [params.todoId],
    })
    const processId = yield* flowExecutionOps.getProcessIdForExecution(
      params.processExecutionId,
    )
    if (processId) {
      add(`${params.dispatchId}:process-event`, PROCESS_EVENT_QUEUE, {
        processId,
      })
    }
    add(`${params.dispatchId}:execution-event`, EXECUTION_EVENT_QUEUE, {
      executionId: params.processExecutionId,
    })
    for (const payload of params.notificationPayloads) {
      const logicalJobId = notificationLogicalId(params.dispatchId, payload)
      add(logicalJobId, NOTIFICATION_DELIVERY_QUEUE, {
        ...payload,
        idempotencyKey: logicalJobId,
      })
    }

    yield* flowExecutionOps.insertFlowDispatchJobs(jobs)
  })

const drainExternalDispatch = (dispatchId: string) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations
    const queueService = yield* QueueService
    const jobs = yield* flowExecutionOps.queryFlowDispatchJobs(dispatchId)

    for (const job of jobs) {
      yield* queueService.enqueue(job.queue, job.payload, {
        logicalJobId: job.logicalJobId,
      })
      yield* flowExecutionOps.deleteFlowDispatchJob(job.id)
    }

    return jobs.length > 0
  })

const resolveResponsibleProviderRecipients = (
  target: PublicCompletionInvitationAttemptCallbackTarget,
) =>
  Effect.gen(function* () {
    const flowExecutionOps = yield* FlowExecutionOperations

    if (target.assignedToProviderUserId !== null) {
      const recipient =
        yield* flowExecutionOps.queryNotificationRecipientByProviderUserId(
          target.assignedToProviderUserId,
        )
      return recipient ? [recipient] : []
    }

    if (target.roleId === null) {
      return []
    }

    return yield* flowExecutionOps.queryNotificationRecipientsByRoleId(
      target.roleId,
    )
  })

const formatNotificationRecipientDisplayName = (
  recipient: NotificationRecipientRow,
): string | undefined => {
  const fullName = recipient.name.trim()
  if (fullName.length > 0) return fullName

  const fallbackName = `${recipient.firstName} ${recipient.lastName}`.trim()
  return fallbackName.length > 0 ? fallbackName : undefined
}

const hasEnabledCorrectionConfig = (stepPath: string) =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    if (Option.isNone(organisationProvider)) return false

    let step: PublicCompletionStepShape | undefined
    try {
      step = organisationProvider.value.organisation.stepByPath(stepPath) as
        | PublicCompletionStepShape
        | undefined
    } catch (error) {
      yield* Effect.logWarning(
        "Public-completion correction config lookup failed",
        { stepPath, error: String(error) },
      )
      return false
    }
    return (
      step?.isForm === true &&
      step.publicCompletion?.correction?.enabled === true
    )
  })

const resolveCorrectionRequiredNotificationPayloads = (params: {
  readonly target: PublicCompletionInvitationAttemptCallbackTarget
  readonly recipients: readonly NotificationRecipientRow[]
  readonly failureReason: string
}) =>
  Effect.gen(function* () {
    const dedupedRecipients = [
      ...new Map(
        params.recipients
          .filter((recipient) => recipient.email.trim().length > 0)
          .map((recipient) => [
            recipient.email.trim().toLowerCase(),
            recipient,
          ]),
      ).values(),
    ]

    return dedupedRecipients.map((recipient) => {
      const displayName = formatNotificationRecipientDisplayName(recipient)
      const payload: NotificationDeliveryPayload = {
        channel: "email",
        recipient: {
          userId: recipient.userId,
          email: recipient.email,
          ...(displayName ? { displayName } : {}),
        },
        correctionRequired: {
          todoId: params.target.todoId,
          processName: params.target.processName,
          stepName: params.target.stepName,
          failureReason: params.failureReason,
        },
      }

      return payload
    })
  })

const enqueueNotificationPayloads = (
  payloads: readonly NotificationDeliveryPayload[],
) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService

    for (const payload of payloads) {
      yield* queueService.enqueue(NOTIFICATION_DELIVERY_QUEUE, payload)
    }
  })

export const applyPublicCompletionDeliveryCallback = (
  callback: PublicCompletionDeliveryCallback,
) =>
  Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations
    const sqlClient = yield* SqlClient.SqlClient
    const queueService = yield* QueueService

    if (callback.status === "delivered") {
      const deliveryResult = yield* sqlClient.withTransaction(
        Effect.gen(function* () {
          const target =
            yield* stepCompletionOps.queryPublicCompletionInvitationAttemptCallbackTarget(
              callback.todoId,
              callback.invitationAttemptId,
            )
          if (!target) {
            return { _tag: "Ignored" } as const
          }

          const recorded =
            yield* stepCompletionOps.recordPublicCompletionInvitationAttemptDeliveryEvent(
              callback.invitationAttemptId,
              {
                deliveryStatus: "delivered",
                deliveryEventId: callback.deliveryId,
                ...(callback.providerMessageId !== undefined && {
                  providerMessageId: callback.providerMessageId,
                }),
              },
            )

          return recorded
            ? ({ _tag: "Delivered" } as const)
            : ({ _tag: "Ignored" } as const)
        }),
      )

      if (deliveryResult._tag === "Ignored") {
        yield* Effect.logInfo(
          "Ignoring public-completion delivery callback for a stale or non-waiting attempt",
          {
            todoId: callback.todoId,
            invitationAttemptId: callback.invitationAttemptId,
            deliveryId: callback.deliveryId,
          },
        )
      }

      return deliveryResult
    }

    const failureReason = formatFailureReason(callback)
    if (!queueService.queueInTransaction) {
      const correctionDispatchId = callbackDispatchId(callback, "correction")
      if (yield* drainExternalDispatch(correctionDispatchId)) {
        return { _tag: "CorrectionRequired" } as const
      }
      const failedDispatchId = callbackDispatchId(callback, "failed")
      if (yield* drainExternalDispatch(failedDispatchId)) {
        return { _tag: "Failed" } as const
      }
    }

    const failResult: PublicCompletionDeliveryCallbackInternalResult =
      yield* sqlClient.withTransaction(
        Effect.gen(function* () {
          const target =
            yield* stepCompletionOps.queryPublicCompletionInvitationAttemptCallbackTarget(
              callback.todoId,
              callback.invitationAttemptId,
            )
          if (!target) {
            return { _tag: "Ignored" } as const
          }

          const recorded =
            yield* stepCompletionOps.recordPublicCompletionInvitationAttemptDeliveryEvent(
              callback.invitationAttemptId,
              {
                deliveryStatus: "failed",
                deliveryEventId: callback.deliveryId,
                deliveryFailureKind: callback.failureKind,
                deliveryFailureReason: failureReason,
                ...(callback.providerMessageId !== undefined && {
                  providerMessageId: callback.providerMessageId,
                }),
              },
            )
          if (!recorded) {
            return { _tag: "Ignored" } as const
          }

          const shouldEnterCorrection =
            callback.failureKind === "recipient_address" &&
            (yield* hasEnabledCorrectionConfig(target.stepPath))

          if (shouldEnterCorrection) {
            const didEnterCorrection =
              yield* stepCompletionOps.enterPublicCompletionCorrectionRequired({
                todoId: callback.todoId,
                invitationAttemptId: callback.invitationAttemptId,
                failureReason,
              })
            if (!didEnterCorrection) {
              return { _tag: "DeliveryRecordedTodoNotCorrected" } as const
            }

            const responsibleRecipients =
              yield* resolveResponsibleProviderRecipients(target)
            const notificationPayloads =
              yield* resolveCorrectionRequiredNotificationPayloads({
                target,
                recipients: responsibleRecipients,
                failureReason,
              })

            if (queueService.queueInTransaction) {
              yield* enqueueTodoProcessExecutionEvents({
                todoId: callback.todoId,
                processExecutionId: target.processExecutionId,
              })
              yield* enqueueNotificationPayloads(notificationPayloads)
            } else {
              yield* persistExternalDispatch({
                dispatchId: callbackDispatchId(callback, "correction"),
                todoId: callback.todoId,
                processExecutionId: target.processExecutionId,
                notificationPayloads,
              })
            }

            return { _tag: "CorrectionRequired" } as const
          }

          const didFail = yield* stepCompletionOps.failAsyncToDo(
            callback.todoId,
            failureReason,
          )
          if (!didFail) {
            return { _tag: "DeliveryRecordedTodoNotFailed" } as const
          }

          const responsibleRecipients =
            yield* resolveResponsibleProviderRecipients(target)
          const notificationPayloads =
            yield* resolveExecutionFailureNotificationPayloads({
              processExecutionId: target.processExecutionId,
              stepPath: target.stepPath,
              processName: target.processName,
              failureReason,
              additionalRecipients: responsibleRecipients,
            })

          if (queueService.queueInTransaction) {
            yield* enqueueTodoProcessExecutionEvents({
              todoId: callback.todoId,
              processExecutionId: target.processExecutionId,
            })
            yield* enqueueNotificationPayloads(notificationPayloads)
          } else {
            yield* persistExternalDispatch({
              dispatchId: callbackDispatchId(callback, "failed"),
              todoId: callback.todoId,
              processExecutionId: target.processExecutionId,
              notificationPayloads,
            })
          }

          return { _tag: "Failed" } as const
        }),
      )

    if (
      !queueService.queueInTransaction &&
      (failResult._tag === "CorrectionRequired" || failResult._tag === "Failed")
    ) {
      yield* drainExternalDispatch(
        callbackDispatchId(
          callback,
          failResult._tag === "CorrectionRequired" ? "correction" : "failed",
        ),
      )
    }

    if (failResult._tag === "DeliveryRecordedTodoNotCorrected") {
      // The delivery write committed, but the Todo was concurrently resolved
      // before it could enter correction. Treat the callback as handled without
      // enqueueing correction follow-up work for a no-longer-waiting Todo.
      yield* Effect.logInfo(
        "Public-completion failure callback recorded but todo could not enter correction",
        {
          todoId: callback.todoId,
          invitationAttemptId: callback.invitationAttemptId,
          deliveryId: callback.deliveryId,
          failureKind: callback.failureKind,
        },
      )
      return { _tag: "Ignored" } as const
    }

    if (failResult._tag === "DeliveryRecordedTodoNotFailed") {
      // The delivery write committed, but the Todo was concurrently completed or
      // failed before failAsyncToDo could mark it. Treat the callback as handled
      // without enqueueing failure follow-up work for a no-longer-waiting Todo.
      yield* Effect.logInfo(
        "Public-completion failure callback recorded but todo was already resolved",
        {
          todoId: callback.todoId,
          invitationAttemptId: callback.invitationAttemptId,
          deliveryId: callback.deliveryId,
          failureKind: callback.failureKind,
        },
      )
      return { _tag: "Ignored" } as const
    }

    if (failResult._tag === "Ignored") {
      yield* Effect.logInfo(
        "Ignoring public-completion failure callback for a stale or non-waiting attempt",
        {
          todoId: callback.todoId,
          invitationAttemptId: callback.invitationAttemptId,
          deliveryId: callback.deliveryId,
          failureKind: callback.failureKind,
        },
      )
      return { _tag: "Ignored" } as const
    }

    return failResult._tag === "CorrectionRequired"
      ? ({ _tag: "CorrectionRequired" } as const)
      : ({ _tag: "Failed" } as const)
  })
