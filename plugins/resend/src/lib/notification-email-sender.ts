import {
  DocumentStoreService,
  EmailSender,
  NotificationDeliverySendError,
} from "@processfocus/runtime"
import { Effect, Layer } from "effect"
import { Base64 } from "effect/encoding"
import { ResendClient } from "./resend-client"

export const ResendNotificationEmailSenderLive = Layer.effect(
  EmailSender,
  Effect.gen(function* () {
    const resendClient = yield* ResendClient
    const documentStore = yield* DocumentStoreService

    return {
      send: (message, options) =>
        Effect.gen(function* () {
          const attachments = yield* Effect.forEach(
            message.attachments ?? [],
            (attachment) =>
              documentStore
                .getFileContent(attachment.fileId, attachment.storePrefix)
                .pipe(
                  Effect.map(({ content }) => ({
                    filename: attachment.filename,
                    content: Base64.encode(content),
                  })),
                ),
          )
          const result = yield* resendClient.sendEmail({
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
            ...(attachments.length > 0 && { attachments }),
            ...(message.tags !== undefined && { tags: message.tags }),
          })

          return {
            providerMessageId: result.emailId,
            // Audit text only; do not split this for webhook correlation.
            providerSentTo:
              typeof result.sentTo === "string"
                ? result.sentTo
                : result.sentTo.join(", "),
          }
        }).pipe(
          Effect.mapError(
            (cause) =>
              new NotificationDeliverySendError({
                recipientEmail: message.to,
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          ),
        ),
    }
  }),
)
