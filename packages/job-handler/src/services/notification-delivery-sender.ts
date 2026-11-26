import { type EmailMessage, EmailSender } from "@processfocus/runtime"
import { Effect, Layer } from "effect"

/**
 * Default sender used when no org-specific email handler is configured.
 *
 * Notification delivery is best-effort; logging and continuing is safer than
 * crashing the worker for an unconfigured sender.
 */
export const LoggingEmailSenderLive = Layer.succeed(EmailSender, {
  loggingOnly: true,
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
