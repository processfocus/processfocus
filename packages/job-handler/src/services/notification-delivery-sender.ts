import type { StoredEmailAttachment } from "@processfocus/runtime"
import { Context, Data, Effect, Layer } from "effect"

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

/**
 * Error thrown when sending a notification delivery fails.
 */
export class NotificationDeliverySendError extends Data.TaggedError(
  "NotificationDeliverySendError",
)<{
  readonly recipientEmail: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Runtime-selected email sender used by notification delivery.
 *
 * The notification-delivery handler renders the final email before delegating
 * actual transport here, keeping provider selection swappable.
 */
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

/**
 * Default sender used when no org-specific email handler is configured.
 *
 * Notification delivery is best-effort; logging and continuing is safer than
 * crashing the worker for an unconfigured sender.
 */
export const LoggingEmailSenderLive = Layer.succeed(EmailSender, {
  send: (message: EmailMessage) =>
    Effect.logWarning("No EmailSender configured for notification delivery", {
      to: message.to,
      from: message.from,
      subject: message.subject,
      ...(message.template !== undefined && {
        templateId: message.template.id,
      }),
      ...(message.attachments !== undefined && {
        attachmentCount: message.attachments.length,
      }),
      ...(message.tags !== undefined && { tagCount: message.tags.length }),
    }).pipe(Effect.as(undefined)),
})
