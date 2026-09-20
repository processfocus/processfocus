import { Effect, Layer } from "effect"
import {
  type EmailMessage,
  EmailSender,
  NotificationDeliveryConfig,
  NotificationDeliverySendError,
} from "@pf/job-handler"
import {
  ResendClient,
  ResendDeferredDelivery,
  type ResendEmailRequest,
  type ResendEmailResponse,
  type ResendEmailTemplate,
  ResendError,
} from "./resend-client"
import {
  RESEND_PUBLIC_COMPLETION_INVITATION_ATTEMPT_TAG_NAME,
  RESEND_PUBLIC_COMPLETION_TODO_TAG_NAME,
  RESEND_TODO_TAG_NAME,
  makeResendWebhookHeaders,
} from "./resend-webhook-event"

export const DEFAULT_MOCK_RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from(
  "mock-resend-webhook-secret",
).toString("base64")}`

export interface MockResendSenderIdentity {
  readonly email: string
  readonly name?: string
}

export interface MockResendPluginOptions {
  readonly enabled?: boolean
  readonly rerouteEmail?: string
  readonly environment?: string
  readonly frontendBaseUrl?: string
  readonly sender?: MockResendSenderIdentity | null
  readonly webhookSecret?: string
  readonly webhookUrl?: string
  readonly emailIdPrefix?: string
  readonly deliveryIdPrefix?: string
  readonly now?: () => Date
}

export interface MockResendSentMessage {
  readonly emailId: string
  readonly originalRequest: ResendEmailRequest
  readonly request: ResendEmailRequest
  readonly originalTo: string | readonly string[]
  readonly sentTo: string | readonly string[]
  readonly rerouted: boolean
  readonly createdAt: string
}

export type MockResendWebhookEventType =
  | "email.delivered"
  | "email.bounced"
  | "email.suppressed"
  | "email.failed"

export interface MockResendWebhookPayload {
  readonly type: MockResendWebhookEventType
  readonly created_at: string
  readonly data: {
    readonly created_at: string
    readonly email_id: string
    readonly from?: string
    readonly subject?: string
    readonly to: readonly string[]
    readonly tags: Readonly<Record<string, string>>
    readonly bounce?: {
      readonly type: string
      readonly subType: string
      readonly message: string
    }
    readonly failed?: {
      readonly reason: string
      readonly recipient: string
    }
    readonly suppressed?: {
      readonly reason: string
      readonly recipient: string
    }
  }
}

export interface MockResendSignedCallback {
  readonly request: Request
  readonly headers: Headers
  readonly body: string
  readonly payload: MockResendWebhookPayload
  readonly webhookSecret: string
}

export type MockResendMessageRef = string | MockResendSentMessage

export interface MockResendEventOptions {
  readonly deliveryId?: string
  readonly timestampSeconds?: number
  readonly eventCreatedAt?: string
  readonly emailCreatedAt?: string
  readonly webhookUrl?: string
}

export interface MockResendBounceEventOptions extends MockResendEventOptions {
  readonly bounceType?: string
  readonly bounceSubType?: string
  readonly message?: string
}

export interface MockResendSuppressionEventOptions
  extends MockResendEventOptions {
  readonly recipient?: string
  readonly reason?: string
}

export interface MockResendRecipientFailureEventOptions
  extends MockResendEventOptions {
  readonly recipient?: string
  readonly reason?: string
}

export interface MockResendController {
  readonly webhookSecret: string
  readonly listSentMessages: () => readonly MockResendSentMessage[]
  readonly clear: () => void
  readonly findMessageByEmailId: (
    emailId: string,
  ) => MockResendSentMessage | undefined
  readonly findMessageByTodoId: (
    todoId: string,
  ) => MockResendSentMessage | undefined
  readonly findMessageByPublicCompletionInvitationAttemptId: (
    attemptId: string,
  ) => MockResendSentMessage | undefined
  readonly emitDelivery: (
    message: MockResendMessageRef,
    options?: MockResendEventOptions,
  ) => MockResendSignedCallback
  readonly emitBounce: (
    message: MockResendMessageRef,
    options?: MockResendBounceEventOptions,
  ) => MockResendSignedCallback
  readonly emitSuppression: (
    message: MockResendMessageRef,
    options?: MockResendSuppressionEventOptions,
  ) => MockResendSignedCallback
  readonly emitRecipientFailure: (
    message: MockResendMessageRef,
    options?: MockResendRecipientFailureEventOptions,
  ) => MockResendSignedCallback
}

export interface MockResendPlugin {
  readonly layer: Layer.Layer<
    | ResendClient
    | EmailSender
    | NotificationDeliveryConfig
    | ResendDeferredDelivery,
    never,
    never
  >
  readonly controller: MockResendController
}

interface MockResendSettings {
  readonly enabled: boolean
  readonly rerouteEmail: string | undefined
  readonly environment: string
  readonly frontendBaseUrl: string
  readonly sender: MockResendSenderIdentity | null
  readonly webhookSecret: string
  readonly webhookUrl: string
  readonly emailIdPrefix: string
  readonly deliveryIdPrefix: string
  readonly now: () => Date
}

interface ResolvedSend {
  readonly _tag: "ResolvedSend"
  readonly request: ResendEmailRequest
  readonly sentTo: string | readonly string[]
  readonly rerouted: boolean
}

interface FailedSend {
  readonly _tag: "FailedSend"
  readonly error: ResendError
  readonly defect?: boolean
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const formatRecipients = (to: string | readonly string[]): string =>
  typeof to === "string" ? to : to.join(", ")

const targetsOnlyRerouteEmail = (
  to: string | readonly string[],
  rerouteEmail: string,
): boolean => {
  const normalizedRerouteEmail = normalizeEmail(rerouteEmail)
  const recipients = Array.isArray(to) ? to : [to]

  return (
    recipients.length > 0 &&
    recipients.every(
      (recipient) => normalizeEmail(recipient) === normalizedRerouteEmail,
    )
  )
}

const toRecipientArray = (to: string | readonly string[]): readonly string[] =>
  typeof to === "string" ? [to] : [...to]

const toEventRecipientArray = (
  to: string | readonly string[],
): readonly string[] => {
  const recipients = toRecipientArray(to)
  if (recipients.length === 0) {
    throw new Error("Mock Resend event requires at least one recipient")
  }

  return recipients
}

const getFirstEventRecipient = (to: string | readonly string[]): string => {
  if (typeof to === "string") {
    return to
  }

  const [recipient] = to
  if (recipient === undefined) {
    throw new Error("Mock Resend event requires at least one recipient")
  }

  return recipient
}

const cloneStringOrArray = (
  value: string | readonly string[],
): string | readonly string[] =>
  typeof value === "string" ? value : [...value]

const cloneTemplate = (template: ResendEmailTemplate): ResendEmailTemplate => ({
  id: template.id,
  ...(template.variables !== undefined && {
    variables: { ...template.variables },
  }),
})

const cloneRequest = (request: ResendEmailRequest): ResendEmailRequest => ({
  to: cloneStringOrArray(request.to),
  ...(request.subject !== undefined && { subject: request.subject }),
  ...(request.html !== undefined && { html: request.html }),
  ...(request.text !== undefined && { text: request.text }),
  ...(request.template !== undefined && {
    template: cloneTemplate(request.template),
  }),
  ...(request.from !== undefined && { from: request.from }),
  ...(request.replyTo !== undefined && {
    replyTo: cloneStringOrArray(request.replyTo),
  }),
  ...(request.cc !== undefined && { cc: cloneStringOrArray(request.cc) }),
  ...(request.bcc !== undefined && { bcc: cloneStringOrArray(request.bcc) }),
  ...(request.headers !== undefined && { headers: { ...request.headers } }),
  ...(request.attachments !== undefined && {
    attachments: request.attachments.map((attachment) => ({ ...attachment })),
  }),
  ...(request.tags !== undefined && {
    tags: request.tags.map((tag) => ({ ...tag })),
  }),
})

const cloneSentMessage = (
  message: MockResendSentMessage,
): MockResendSentMessage => ({
  emailId: message.emailId,
  originalRequest: cloneRequest(message.originalRequest),
  request: cloneRequest(message.request),
  originalTo: cloneStringOrArray(message.originalTo),
  sentTo: cloneStringOrArray(message.sentTo),
  rerouted: message.rerouted,
  createdAt: message.createdAt,
})

const cloneFoundMessage = (
  message: MockResendSentMessage | undefined,
): MockResendSentMessage | undefined =>
  message === undefined ? undefined : cloneSentMessage(message)

const tagsToRecord = (
  tags:
    | readonly { readonly name: string; readonly value: string }[]
    | undefined,
): Readonly<Record<string, string>> => {
  const record: Record<string, string> = {}
  for (const tag of tags ?? []) {
    record[tag.name] = tag.value
  }

  return record
}

const findTag = (
  message: MockResendSentMessage,
  tagNames: readonly string[],
): string | undefined => {
  for (const tag of message.request.tags ?? []) {
    if (tagNames.includes(tag.name)) {
      return tag.value
    }
  }

  return undefined
}

const resolveSend = (
  message: ResendEmailRequest,
  settings: MockResendSettings,
): ResolvedSend | FailedSend => {
  if (toRecipientArray(message.to).length === 0) {
    return {
      _tag: "FailedSend",
      error: new ResendError({
        message: "Mock Resend requires at least one recipient",
      }),
    }
  }

  let actualTo: string | readonly string[] = message.to
  let rerouteAddress: string | undefined

  if (!settings.enabled) {
    if (settings.rerouteEmail === undefined) {
      return {
        _tag: "FailedSend",
        error: new ResendError({
          message:
            "RESEND_REROUTE_EMAIL must be set when RESEND_ENABLED is false",
        }),
        defect: true,
      }
    }

    if (!targetsOnlyRerouteEmail(message.to, settings.rerouteEmail)) {
      actualTo = settings.rerouteEmail
      rerouteAddress = settings.rerouteEmail
    }
  }

  const originalToHeader = formatRecipients(message.to)
  const rerouted = rerouteAddress !== undefined
  const rerouteHeaders: Readonly<Record<string, string>> =
    rerouteAddress === undefined
      ? {}
      : {
          "ProcessFocus-Rerouted": "true",
          "ProcessFocus-Original-To": originalToHeader,
          "ProcessFocus-Rerouted-To": rerouteAddress,
          "ProcessFocus-Reroute-Reason": "resend_disabled",
        }
  const effectiveHeaders: Readonly<Record<string, string>> = {
    ...message.headers,
    "ProcessFocus-Env": settings.environment,
    ...rerouteHeaders,
  }
  const effectiveSubject =
    rerouted && message.subject !== undefined
      ? `[REROUTED] ${message.subject}`
      : message.subject

  return {
    _tag: "ResolvedSend",
    sentTo: actualTo,
    rerouted,
    request: {
      to: actualTo,
      ...(message.from !== undefined && { from: message.from }),
      ...(effectiveSubject !== undefined && { subject: effectiveSubject }),
      ...(message.html !== undefined && { html: message.html }),
      ...(message.text !== undefined && { text: message.text }),
      ...(message.template !== undefined && { template: message.template }),
      ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
      ...(!rerouted && message.cc !== undefined && { cc: message.cc }),
      ...(!rerouted && message.bcc !== undefined && { bcc: message.bcc }),
      ...(message.attachments !== undefined && {
        attachments: message.attachments,
      }),
      ...(message.tags !== undefined && { tags: message.tags }),
      headers: effectiveHeaders,
    },
  }
}

const makeBasePayload = (
  eventType: MockResendWebhookEventType,
  message: MockResendSentMessage,
  options: MockResendEventOptions | undefined,
): MockResendWebhookPayload => ({
  type: eventType,
  created_at: options?.eventCreatedAt ?? message.createdAt,
  data: {
    created_at: options?.emailCreatedAt ?? message.createdAt,
    email_id: message.emailId,
    ...(message.request.from !== undefined && { from: message.request.from }),
    ...(message.request.subject !== undefined && {
      subject: message.request.subject,
    }),
    to: toEventRecipientArray(message.sentTo),
    tags: tagsToRecord(message.request.tags),
  },
})

const makeSettings = (
  options: MockResendPluginOptions,
): MockResendSettings => ({
  enabled: options.enabled ?? true,
  rerouteEmail: options.rerouteEmail,
  environment: options.environment ?? "test",
  frontendBaseUrl: options.frontendBaseUrl ?? "http://localhost:3000",
  sender:
    options.sender === undefined
      ? { email: "notifications@example.com", name: "Process Focus" }
      : options.sender,
  webhookSecret: options.webhookSecret ?? DEFAULT_MOCK_RESEND_WEBHOOK_SECRET,
  webhookUrl: options.webhookUrl ?? "https://example.com/webhooks/resend",
  emailIdPrefix: options.emailIdPrefix ?? "email_mock",
  deliveryIdPrefix: options.deliveryIdPrefix ?? "msg_mock",
  // Callers with fake-time assertions can inject a deterministic clock.
  now: options.now ?? (() => new Date()),
})

export const makeMockResendPlugin = (
  options: MockResendPluginOptions = {},
): MockResendPlugin => {
  const settings = makeSettings(options)
  const messages: MockResendSentMessage[] = []
  let nextEmailSequence = 1
  let nextDeliverySequence = 1

  const nextEmailId = () => {
    const emailId = `${settings.emailIdPrefix}_${String(nextEmailSequence).padStart(6, "0")}`
    nextEmailSequence += 1
    return emailId
  }

  const nextDeliveryId = () => {
    const deliveryId = `${settings.deliveryIdPrefix}_${String(nextDeliverySequence).padStart(6, "0")}`
    nextDeliverySequence += 1
    return deliveryId
  }

  const requireMessage = (messageRef: MockResendMessageRef) => {
    const emailId =
      typeof messageRef === "string" ? messageRef : messageRef.emailId
    const message = messages.find(
      (sentMessage) => sentMessage.emailId === emailId,
    )
    if (message === undefined) {
      throw new Error(`Mock Resend message not found: ${emailId}`)
    }

    return message
  }

  const signPayload = (
    payload: MockResendWebhookPayload,
    eventOptions: MockResendEventOptions | undefined,
  ): MockResendSignedCallback => {
    const body = JSON.stringify(payload)
    const deliveryId = eventOptions?.deliveryId ?? nextDeliveryId()
    const timestamp = String(
      eventOptions?.timestampSeconds ??
        Math.floor(settings.now().getTime() / 1000),
    )
    const headers = makeResendWebhookHeaders({
      payload: body,
      webhookSecret: settings.webhookSecret,
      deliveryId,
      timestamp,
    })

    return {
      request: new Request(eventOptions?.webhookUrl ?? settings.webhookUrl, {
        method: "POST",
        headers,
        body,
      }),
      headers,
      body,
      payload,
      webhookSecret: settings.webhookSecret,
    }
  }

  const sendEmail = (
    message: ResendEmailRequest,
  ): Effect.Effect<ResendEmailResponse, ResendError, never> => {
    const resolved = resolveSend(message, settings)
    if (resolved._tag === "FailedSend") {
      if (resolved.defect) {
        return Effect.die(resolved.error)
      }

      return Effect.fail(resolved.error)
    }

    return Effect.sync(() => {
      const emailId = nextEmailId()
      const sentMessage: MockResendSentMessage = {
        emailId,
        originalRequest: cloneRequest(message),
        request: cloneRequest(resolved.request),
        originalTo: cloneStringOrArray(message.to),
        sentTo: cloneStringOrArray(resolved.sentTo),
        rerouted: resolved.rerouted,
        createdAt: settings.now().toISOString(),
      }
      messages.push(sentMessage)

      return { emailId, sentTo: resolved.sentTo }
    })
  }

  const controller: MockResendController = {
    webhookSecret: settings.webhookSecret,
    listSentMessages: () => messages.map(cloneSentMessage),
    clear: () => {
      messages.length = 0
      nextEmailSequence = 1
      nextDeliverySequence = 1
    },
    findMessageByEmailId: (emailId) =>
      cloneFoundMessage(
        messages.find((message) => message.emailId === emailId),
      ),
    findMessageByTodoId: (todoId) =>
      cloneFoundMessage(
        messages.find(
          (message) =>
            findTag(message, [
              RESEND_TODO_TAG_NAME,
              RESEND_PUBLIC_COMPLETION_TODO_TAG_NAME,
            ]) === todoId,
        ),
      ),
    findMessageByPublicCompletionInvitationAttemptId: (attemptId) =>
      cloneFoundMessage(
        messages.find(
          (message) =>
            findTag(message, [
              RESEND_PUBLIC_COMPLETION_INVITATION_ATTEMPT_TAG_NAME,
            ]) === attemptId,
        ),
      ),
    emitDelivery: (messageRef, eventOptions) =>
      signPayload(
        makeBasePayload(
          "email.delivered",
          requireMessage(messageRef),
          eventOptions,
        ),
        eventOptions,
      ),
    emitBounce: (messageRef, eventOptions) => {
      const message = requireMessage(messageRef)
      const payload = makeBasePayload("email.bounced", message, eventOptions)
      return signPayload(
        {
          ...payload,
          data: {
            ...payload.data,
            bounce: {
              type: eventOptions?.bounceType ?? "hard",
              subType: eventOptions?.bounceSubType ?? "general",
              message: eventOptions?.message ?? "Recipient address bounced",
            },
          },
        },
        eventOptions,
      )
    },
    emitSuppression: (messageRef, eventOptions) => {
      const message = requireMessage(messageRef)
      const recipient =
        eventOptions?.recipient ?? getFirstEventRecipient(message.sentTo)
      const payload = makeBasePayload("email.suppressed", message, eventOptions)
      return signPayload(
        {
          ...payload,
          data: {
            ...payload.data,
            suppressed: {
              recipient,
              reason: eventOptions?.reason ?? "hard_bounce",
            },
          },
        },
        eventOptions,
      )
    },
    emitRecipientFailure: (messageRef, eventOptions) => {
      const message = requireMessage(messageRef)
      const recipient =
        eventOptions?.recipient ?? getFirstEventRecipient(message.sentTo)
      const payload = makeBasePayload("email.failed", message, eventOptions)
      return signPayload(
        {
          ...payload,
          data: {
            ...payload.data,
            failed: {
              recipient,
              reason: eventOptions?.reason ?? "recipient_not_found",
            },
          },
        },
        eventOptions,
      )
    },
  }

  const resendClientLayer = Layer.succeed(ResendClient, { sendEmail })

  const notificationEmailSenderLayer = Layer.effect(
    EmailSender,
    Effect.gen(function* () {
      const resendClient = yield* ResendClient

      return {
        send: (message: EmailMessage, options) =>
          resendClient
            .sendEmail({
              ...(options?.idempotencyKey !== undefined && {
                idempotencyKey: options.idempotencyKey,
              }),
              to: message.to,
              from: message.from,
              subject: message.subject,
              ...(message.html !== undefined && { html: message.html }),
              ...(message.template !== undefined && {
                template: message.template,
              }),
              ...(message.tags !== undefined && { tags: message.tags }),
            })
            .pipe(
              Effect.map((result) => ({
                providerMessageId: result.emailId,
                providerSentTo: formatRecipients(result.sentTo),
              })),
              Effect.mapError(
                (cause) =>
                  new NotificationDeliverySendError({
                    recipientEmail: message.to,
                    message: cause.message,
                    cause,
                  }),
              ),
            ),
      }
    }),
  )

  const notificationConfigLayer = Layer.succeed(NotificationDeliveryConfig, {
    getFrontendBaseUrl: () => settings.frontendBaseUrl,
    getEnvironment: () => settings.environment,
    getSenderIdentity: () => settings.sender ?? undefined,
  })
  const deferredDeliveryLayer = Layer.succeed(ResendDeferredDelivery, {
    environment: settings.environment,
  })
  const notificationLayer = Layer.provideMerge(
    notificationEmailSenderLayer,
    resendClientLayer,
  )

  return {
    controller,
    layer: Layer.mergeAll(
      notificationLayer,
      notificationConfigLayer,
      deferredDeliveryLayer,
    ),
  }
}
