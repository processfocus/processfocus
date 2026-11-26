import { Schema } from "effect"

const NotificationRecipientSchema = Schema.Struct({
  userId: Schema.optional(Schema.String),
  email: Schema.String,
  displayName: Schema.optional(Schema.String),
})

const NotificationTodoSchema = Schema.Struct({
  todoId: Schema.String,
  stepPath: Schema.String,
  processName: Schema.String,
  stepName: Schema.String,
})

const CorrectionRequiredNotificationSchema = Schema.Struct({
  todoId: Schema.String,
  processName: Schema.String,
  stepName: Schema.String,
  failureReason: Schema.String,
})

const StoredEmailAttachmentSchema = Schema.Struct({
  filename: Schema.String,
  storePrefix: Schema.String,
  fileId: Schema.String,
})

const PublicTodoNotificationSchema = Schema.Struct({
  todoId: Schema.String,
  processName: Schema.String,
  stepName: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
  publicCompletionInvitationAttemptId: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  template: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      variables: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Number]),
        ),
      ),
    }),
  ),
  attachments: Schema.optional(Schema.Array(StoredEmailAttachmentSchema)),
})

const ExecutionFailureNotificationSchema = Schema.Struct({
  executionId: Schema.String,
  processName: Schema.String,
  failureReason: Schema.String,
  project: Schema.String,
  environment: Schema.String,
})

const AccessReviewControlNotificationSchema = Schema.Struct({
  failureCategory: Schema.Literals([
    "missed-scheduled-start",
    "review-sla-overdue",
    "remediation-sla-overdue",
  ]),
  project: Schema.String,
  environment: Schema.String,
  processPath: Schema.String,
  investigationReference: Schema.String,
  scheduledFor: Schema.optional(Schema.String),
  executionId: Schema.optional(Schema.String),
  todoId: Schema.optional(Schema.String),
  dueAt: Schema.optional(Schema.String),
})

/**
 * Schema for notification-delivery queue job payloads.
 * Each job represents a single recipient delivery for a single channel.
 */
const NotificationDeliveryBase = Schema.Struct({
  channel: Schema.Literal("email"),
  idempotencyKey: Schema.optional(Schema.String),
  recipient: NotificationRecipientSchema,
})
export const NotificationDeliveryPayloadSchema = Schema.Union([
  Schema.Struct({
    ...NotificationDeliveryBase.fields,
    todo: NotificationTodoSchema,
  }),
  Schema.Struct({
    ...NotificationDeliveryBase.fields,
    correctionRequired: CorrectionRequiredNotificationSchema,
  }),
  Schema.Struct({
    ...NotificationDeliveryBase.fields,
    publicTodo: PublicTodoNotificationSchema,
  }),
  Schema.Struct({
    ...NotificationDeliveryBase.fields,
    executionFailure: ExecutionFailureNotificationSchema,
  }),
  Schema.Struct({
    ...NotificationDeliveryBase.fields,
    accessReviewControl: AccessReviewControlNotificationSchema,
  }),
])

export type NotificationDeliveryPayload =
  typeof NotificationDeliveryPayloadSchema.Type
