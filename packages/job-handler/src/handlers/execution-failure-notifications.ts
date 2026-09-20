import { QueueService } from "@processfocus/runtime"
import { Config, Effect, Option } from "effect"
import {
  FlowExecutionOperations,
  NOTIFICATION_DELIVERY_QUEUE,
  type NotificationRecipientRow,
} from "@pf/graphql-db-operations"
import {
  type Organisation,
  OrganisationProvider,
  normalizePath,
} from "@pf/process"
import type { NotificationDeliveryPayload } from "./notification-delivery"

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

const resolveExecutionFailureRolePaths = (organisation: Organisation) => {
  const construct = (() => {
    try {
      return organisation.node.findChild("ExecutionFailureNotifications")
    } catch {
      return undefined
    }
  })()

  if (!isExecutionFailureNotifications(construct)) {
    return []
  }

  return construct.roles.map((role) => normalizePath(role.node.path))
}

const addRecipient = (
  recipients: Map<string, NotificationRecipientRow>,
  recipient: NotificationRecipientRow,
) => {
  if (!recipient.executionFailureEmailEnabled) {
    return
  }

  const email = recipient.email.trim()
  if (email.length === 0) {
    return
  }

  // Dedupe by inbox, not provider-user id, so a person with multiple roles only
  // receives one execution-failure email.
  recipients.set(email.toLowerCase(), recipient)
}

export const resolveExecutionFailureNotificationPayloads = (params: {
  readonly processExecutionId: string
  readonly stepPath: string
  readonly failureReason: string
  readonly processName?: string
  readonly additionalRecipients?: readonly NotificationRecipientRow[]
}) =>
  Effect.gen(function* () {
    const organisationProvider =
      yield* Effect.serviceOption(OrganisationProvider)
    const recipients = new Map<string, NotificationRecipientRow>()

    for (const recipient of params.additionalRecipients ?? []) {
      addRecipient(recipients, recipient)
    }

    let processName = params.processName ?? params.stepPath
    if (Option.isSome(organisationProvider)) {
      const flowExecutionOps = yield* FlowExecutionOperations
      const { organisation } = organisationProvider.value
      const step = organisation.stepByPath(params.stepPath)
      processName =
        params.processName ?? step?.process.props.name ?? params.stepPath

      for (const rolePath of resolveExecutionFailureRolePaths(organisation)) {
        const roleRecipients =
          yield* flowExecutionOps.queryNotificationRecipientsByRolePath(
            rolePath,
          )

        for (const recipient of roleRecipients) {
          addRecipient(recipients, recipient)
        }
      }
    }

    const { project, environment } = yield* Effect.all({
      project: Config.withDefault(Config.string("PF_PROJECT"), "local"),
      environment: Config.withDefault(Config.string("PF_ENV"), "local"),
    })

    return [...recipients.values()].map((recipient) => {
      const displayName = formatNotificationRecipientDisplayName(recipient)
      const payload: NotificationDeliveryPayload = {
        channel: "email",
        recipient: {
          userId: recipient.userId,
          email: recipient.email,
          ...(displayName ? { displayName } : {}),
        },
        executionFailure: {
          executionId: params.processExecutionId,
          processName,
          failureReason: params.failureReason,
          project,
          environment,
        },
      }

      return payload
    })
  })

export const enqueueExecutionFailureNotificationJobs = (params: {
  readonly processExecutionId: string
  readonly stepPath: string
  readonly failureReason: string
  readonly processName?: string
  readonly additionalRecipients?: readonly NotificationRecipientRow[]
}) =>
  Effect.gen(function* () {
    const queueService = yield* QueueService
    const payloads = yield* resolveExecutionFailureNotificationPayloads(params)

    for (const payload of payloads) {
      yield* queueService.enqueue(NOTIFICATION_DELIVERY_QUEUE, payload)
    }
  })
