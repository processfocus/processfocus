import { Context, Data, type Effect } from "effect"

export interface StoredEmailAttachment {
  readonly filename: string
  readonly storePrefix: string
  readonly fileId: string
}

export interface EmailMessage {
  readonly to: string
  readonly from: string
  readonly subject: string
  readonly html?: string
  readonly template?: {
    readonly id: string
    readonly variables?: Record<string, string | number>
  }
  readonly attachments?: readonly StoredEmailAttachment[]
  readonly tags?: readonly { readonly name: string; readonly value: string }[]
}

export interface NotificationDeliveryReceipt {
  readonly providerMessageId: string
  readonly providerSentTo: string
}

export interface NotificationSenderIdentity {
  readonly email: string
  readonly name?: string | undefined
}

/**
 * Shared notification-delivery contracts used by official plugins.
 * Identifiers stay stable so workspace implementations and published plugins
 * resolve the same Effect services.
 */
export class NotificationDeliverySendError extends Data.TaggedError(
  "NotificationDeliverySendError",
)<{
  readonly recipientEmail: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class EmailSender extends Context.Tag("@pf/job-handler/EmailSender")<
  EmailSender,
  {
    readonly send: (
      message: EmailMessage,
      options?: { readonly idempotencyKey?: string },
    ) => Effect.Effect<
      NotificationDeliveryReceipt | undefined,
      NotificationDeliverySendError,
      never
    >
  }
>() {}

export class NotificationDeliveryConfig extends Context.Tag(
  "@pf/job-handler/NotificationDeliveryConfig",
)<
  NotificationDeliveryConfig,
  {
    readonly getFrontendBaseUrl: () => string
    readonly getSenderIdentity: () => NotificationSenderIdentity | undefined
    readonly getEnvironment: () => string | undefined
  }
>() {}
