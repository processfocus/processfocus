import type { Job } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import { StepCompletionOperations } from "@pf/graphql-db-operations"
import { buildPublicTodoUrl } from "@pf/graphql-schema"
import {
  NotificationDeliveryConfig,
  type NotificationSenderIdentity,
} from "../services/notification-delivery-config"
import {
  type EmailMessage,
  EmailSender,
  type NotificationDeliveryReceipt,
} from "../services/notification-delivery-sender"

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
        Schema.Record({
          key: Schema.String,
          value: Schema.Union(Schema.String, Schema.Number),
        }),
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
  failureCategory: Schema.Literal(
    "missed-scheduled-start",
    "review-sla-overdue",
    "remediation-sla-overdue",
  ),
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
export const NotificationDeliveryPayloadSchema = Schema.Struct({
  channel: Schema.Literal("email"),
  idempotencyKey: Schema.optional(Schema.String),
  recipient: NotificationRecipientSchema,
}).pipe(
  Schema.extend(
    Schema.Union(
      Schema.Struct({ todo: NotificationTodoSchema }),
      Schema.Struct({
        correctionRequired: CorrectionRequiredNotificationSchema,
      }),
      Schema.Struct({ publicTodo: PublicTodoNotificationSchema }),
      Schema.Struct({ executionFailure: ExecutionFailureNotificationSchema }),
      Schema.Struct({
        accessReviewControl: AccessReviewControlNotificationSchema,
      }),
    ),
  ),
)

export type NotificationDeliveryPayload =
  typeof NotificationDeliveryPayloadSchema.Type

type TaskAssignmentNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { todo: unknown }
>

type ExecutionFailureNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { executionFailure: unknown }
>

type AccessReviewControlNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { accessReviewControl: unknown }
>

type CorrectionRequiredNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { correctionRequired: unknown }
>

type PublicTodoNotificationDeliveryPayload = Extract<
  NotificationDeliveryPayload,
  { publicTodo: unknown }
>

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const sanitizeSubject = (value: string): string =>
  value.replaceAll(/[\r\n]+/g, " ").trim()

const truncateFailureReason = (value: string): string =>
  value.length > 500 ? `${value.slice(0, 497)}...` : value

const buildTodoCompletionUrl = (
  frontendBaseUrl: string,
  stepPath: string,
  todoId: string,
): string => {
  const normalizedBaseUrl = frontendBaseUrl.endsWith("/")
    ? frontendBaseUrl
    : `${frontendBaseUrl}/`
  const encodedStepPath = stepPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  return new URL(
    `to-dos/complete/${encodedStepPath}?todoId=${encodeURIComponent(todoId)}`,
    normalizedBaseUrl,
  ).toString()
}

const buildTodosUrl = (frontendBaseUrl: string): string => {
  const normalizedBaseUrl = frontendBaseUrl.endsWith("/")
    ? frontendBaseUrl
    : `${frontendBaseUrl}/`

  return new URL("to-dos", normalizedBaseUrl).toString()
}

const buildExecutionUrl = (
  frontendBaseUrl: string,
  executionId: string,
): string => {
  const normalizedBaseUrl = frontendBaseUrl.endsWith("/")
    ? frontendBaseUrl
    : `${frontendBaseUrl}/`

  return new URL(
    `executions/${encodeURIComponent(executionId)}`,
    normalizedBaseUrl,
  ).toString()
}

const formatSenderIdentity = ({
  email,
  name,
}: NotificationSenderIdentity): string =>
  name && name.trim().length > 0 ? `${name} <${email}>` : email

const renderPlainTextWithLinks = (
  value: string,
  links: { readonly publicUrl: string },
): string => {
  const parts: string[] = []
  const markdownLinkPattern = /\[([^\]]+)]\(([^)]+)\)/g
  let lastIndex = 0

  for (const match of value.matchAll(markdownLinkPattern)) {
    const matchIndex = match.index
    const [fullMatch, text, href] = match
    const linkText = text ?? ""
    const linkHref = href ?? ""
    parts.push(escapeHtml(value.slice(lastIndex, matchIndex)))
    // Public todo email bodies are process-authored, trusted templates.
    parts.push(
      `<a href="${escapeHtml(linkHref === "{{publicUrl}}" ? links.publicUrl : linkHref)}">${escapeHtml(linkText)}</a>`,
    )
    lastIndex = matchIndex + fullMatch.length
  }

  parts.push(escapeHtml(value.slice(lastIndex)))
  return parts.join("").replaceAll("\n", "<br />")
}

const renderPlainTextParagraphs = (
  value: string,
  links: { readonly publicUrl: string },
): string =>
  value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${renderPlainTextWithLinks(paragraph, links)}</p>`)
    .join("\n")

const isTaskAssignmentPayload = (
  payload: NotificationDeliveryPayload,
): payload is TaskAssignmentNotificationDeliveryPayload => "todo" in payload

const isCorrectionRequiredPayload = (
  payload: NotificationDeliveryPayload,
): payload is CorrectionRequiredNotificationDeliveryPayload =>
  "correctionRequired" in payload

const isPublicTodoPayload = (
  payload: NotificationDeliveryPayload,
): payload is PublicTodoNotificationDeliveryPayload => "publicTodo" in payload

const isAccessReviewControlPayload = (
  payload: NotificationDeliveryPayload,
): payload is AccessReviewControlNotificationDeliveryPayload =>
  "accessReviewControl" in payload

const isExecutionFailurePayload = (
  payload: NotificationDeliveryPayload,
): payload is ExecutionFailureNotificationDeliveryPayload =>
  "executionFailure" in payload

const buildTaskAssignmentEmail = (
  payload: TaskAssignmentNotificationDeliveryPayload,
  frontendBaseUrl: string,
  sender: NotificationSenderIdentity,
): EmailMessage => {
  const todoUrl = buildTodoCompletionUrl(
    frontendBaseUrl,
    payload.todo.stepPath,
    payload.todo.todoId,
  )
  const greeting =
    payload.recipient.displayName &&
    payload.recipient.displayName.trim().length > 0
      ? `Hello ${escapeHtml(payload.recipient.displayName)},`
      : "Hello,"

  return {
    to: payload.recipient.email,
    from: formatSenderIdentity(sender),
    subject: sanitizeSubject(
      `New task assigned: ${payload.todo.processName} / ${payload.todo.stepName}`,
    ),
    html: `
      <p>${greeting}</p>
      <p>You have a new task assigned in <strong>${escapeHtml(payload.todo.processName)}</strong>.</p>
      <p>Step: <strong>${escapeHtml(payload.todo.stepName)}</strong></p>
      <p><a href="${escapeHtml(todoUrl)}">Open to-do</a></p>
      <p>If the link does not work, use this URL:<br /><a href="${escapeHtml(todoUrl)}">${escapeHtml(todoUrl)}</a></p>
    `.trim(),
  }
}

const buildExecutionFailureEmail = (
  payload: ExecutionFailureNotificationDeliveryPayload,
  frontendBaseUrl: string,
  sender: NotificationSenderIdentity,
): EmailMessage => {
  const executionUrl = buildExecutionUrl(
    frontendBaseUrl,
    payload.executionFailure.executionId,
  )
  const greeting =
    payload.recipient.displayName &&
    payload.recipient.displayName.trim().length > 0
      ? `Hello ${escapeHtml(payload.recipient.displayName)},`
      : "Hello,"
  const failureReason = truncateFailureReason(
    payload.executionFailure.failureReason,
  )

  return {
    to: payload.recipient.email,
    from: formatSenderIdentity(sender),
    subject: sanitizeSubject(
      `[${payload.executionFailure.project}/${payload.executionFailure.environment}] Fatal execution failure: ${payload.executionFailure.processName}`,
    ),
    html: `
      <p>${greeting}</p>
      <p>A fatal execution failure occurred in <strong>${escapeHtml(payload.executionFailure.processName)}</strong>.</p>
      <p>Project/environment: <strong>${escapeHtml(payload.executionFailure.project)}/${escapeHtml(payload.executionFailure.environment)}</strong></p>
      <p>Failure reason:</p>
      <pre>${escapeHtml(failureReason)}</pre>
      <p><a href="${escapeHtml(executionUrl)}">Open execution</a></p>
      <p>If the link does not work, use this URL:<br /><a href="${escapeHtml(executionUrl)}">${escapeHtml(executionUrl)}</a></p>
    `.trim(),
  }
}

const accessReviewControlCategoryLabel = (
  category: AccessReviewControlNotificationDeliveryPayload["accessReviewControl"]["failureCategory"],
): string => {
  switch (category) {
    case "missed-scheduled-start":
      return "Missed scheduled start"
    case "review-sla-overdue":
      return "Access Review SLA overdue"
    case "remediation-sla-overdue":
      return "Access Remediation SLA overdue"
  }
}

/**
 * Administrator email for Weekly Access Review control conditions.
 * Operational identifiers only — never roster rows or credential content.
 */
const buildAccessReviewControlEmail = (
  payload: AccessReviewControlNotificationDeliveryPayload,
  frontendBaseUrl: string,
  sender: NotificationSenderIdentity,
): EmailMessage => {
  const control = payload.accessReviewControl
  const greeting =
    payload.recipient.displayName &&
    payload.recipient.displayName.trim().length > 0
      ? `Hello ${escapeHtml(payload.recipient.displayName)},`
      : "Hello,"
  const categoryLabel = accessReviewControlCategoryLabel(
    control.failureCategory,
  )
  const navigationUrl =
    control.executionId !== undefined
      ? buildExecutionUrl(frontendBaseUrl, control.executionId)
      : buildTodosUrl(frontendBaseUrl)

  const detailRows: string[] = [
    `<p>Category: <strong>${escapeHtml(categoryLabel)}</strong></p>`,
    `<p>Project/environment: <strong>${escapeHtml(control.project)}/${escapeHtml(control.environment)}</strong></p>`,
    `<p>Process: <strong>${escapeHtml(control.processPath)}</strong></p>`,
  ]
  if (control.scheduledFor !== undefined) {
    detailRows.push(
      `<p>Scheduled for: <strong>${escapeHtml(control.scheduledFor)}</strong></p>`,
    )
  }
  if (control.executionId !== undefined) {
    detailRows.push(
      `<p>Execution ID: <strong>${escapeHtml(control.executionId)}</strong></p>`,
    )
  }
  if (control.todoId !== undefined) {
    detailRows.push(
      `<p>Todo ID: <strong>${escapeHtml(control.todoId)}</strong></p>`,
    )
  }
  if (control.dueAt !== undefined) {
    detailRows.push(
      `<p>Due at: <strong>${escapeHtml(control.dueAt)}</strong></p>`,
    )
  }
  detailRows.push(
    `<p>Investigation: ${escapeHtml(control.investigationReference)}</p>`,
  )

  return {
    to: payload.recipient.email,
    from: formatSenderIdentity(sender),
    subject: sanitizeSubject(
      `[${control.project}/${control.environment}] Weekly Access Review: ${categoryLabel}`,
    ),
    html: `
      <p>${greeting}</p>
      <p>A Weekly Access Review control condition requires Administrator attention.</p>
      ${detailRows.join("\n      ")}
      <p><a href="${escapeHtml(navigationUrl)}">Open in Process Focus</a></p>
      <p>If the link does not work, use this URL:<br /><a href="${escapeHtml(navigationUrl)}">${escapeHtml(navigationUrl)}</a></p>
    `.trim(),
  }
}

const buildCorrectionRequiredEmail = (
  payload: CorrectionRequiredNotificationDeliveryPayload,
  frontendBaseUrl: string,
  sender: NotificationSenderIdentity,
): EmailMessage => {
  const todosUrl = buildTodosUrl(frontendBaseUrl)
  const greeting =
    payload.recipient.displayName &&
    payload.recipient.displayName.trim().length > 0
      ? `Hello ${escapeHtml(payload.recipient.displayName)},`
      : "Hello,"

  return {
    to: payload.recipient.email,
    from: formatSenderIdentity(sender),
    subject: sanitizeSubject(
      `Correction required: ${payload.correctionRequired.processName} / ${payload.correctionRequired.stepName}`,
    ),
    html: `
      <p>${greeting}</p>
      <p>A Public Completion invitation could not be delivered for <strong>${escapeHtml(payload.correctionRequired.processName)}</strong>.</p>
      <p>Step: <strong>${escapeHtml(payload.correctionRequired.stepName)}</strong></p>
      <p>Failure reason:</p>
      <pre>${escapeHtml(payload.correctionRequired.failureReason)}</pre>
      <p><a href="${escapeHtml(todosUrl)}">Go to My To-Dos</a></p>
      <p>If the link does not work, use this URL:<br /><a href="${escapeHtml(todosUrl)}">${escapeHtml(todosUrl)}</a></p>
    `.trim(),
  }
}

const buildPublicTodoEmail = (
  payload: PublicTodoNotificationDeliveryPayload,
  frontendBaseUrl: string,
  sender: NotificationSenderIdentity,
  environment: string | undefined,
): EmailMessage => {
  const todoUrl = buildPublicTodoUrl(frontendBaseUrl, payload.publicTodo.token)
  const greeting =
    payload.recipient.displayName &&
    payload.recipient.displayName.trim().length > 0
      ? `Hello ${escapeHtml(payload.recipient.displayName)},`
      : "Hello,"
  const body = payload.publicTodo.body
  const template = payload.publicTodo.template
  const bodyHtml = body
    ? renderPlainTextParagraphs(body, { publicUrl: todoUrl })
    : `<p>${greeting}</p>\n<p>Please complete ${escapeHtml(payload.publicTodo.stepName)} for ${escapeHtml(payload.publicTodo.processName)}.</p>`
  const openFormHtml = body
    ? ""
    : `\n      <p><a href="${escapeHtml(todoUrl)}">Open form</a></p>`

  return {
    to: payload.recipient.email,
    from: payload.publicTodo.from ?? formatSenderIdentity(sender),
    subject: sanitizeSubject(
      payload.publicTodo.subject ??
        `Complete form: ${payload.publicTodo.processName} / ${payload.publicTodo.stepName}`,
    ),
    ...(payload.publicTodo.attachments !== undefined && {
      attachments: payload.publicTodo.attachments,
    }),
    ...(payload.publicTodo.publicCompletionInvitationAttemptId !==
      undefined && {
      tags: [
        {
          name: "pf_public_completion_todo_id",
          value: payload.publicTodo.todoId,
        },
        {
          name: "pf_public_completion_environment",
          value: environment ?? "unknown",
        },
        {
          name: "pf_public_completion_invitation_attempt_id",
          value: payload.publicTodo.publicCompletionInvitationAttemptId,
        },
      ],
    }),
    ...(template !== undefined
      ? {
          template: {
            id: template.id,
            variables: {
              ...template.variables,
              PUBLIC_URL: todoUrl,
            },
          },
        }
      : {
          html: `
      ${bodyHtml}
      ${openFormHtml}
      <p>If the link above does not work, use this URL:<br /><a href="${escapeHtml(todoUrl)}">${escapeHtml(todoUrl)}</a></p>
    `.trim(),
        }),
  }
}

const recordPublicCompletionInvitationReceipt = (
  payload: PublicTodoNotificationDeliveryPayload,
  receipt: NotificationDeliveryReceipt | undefined,
) => {
  const attemptId = payload.publicTodo.publicCompletionInvitationAttemptId
  if (attemptId === undefined || receipt === undefined) {
    return Effect.void
  }

  return Effect.gen(function* () {
    const stepCompletionOps = yield* StepCompletionOperations
    const recorded =
      yield* stepCompletionOps.recordPublicCompletionInvitationAttemptReceipt(
        attemptId,
        {
          providerMessageId: receipt.providerMessageId,
          providerSentTo: receipt.providerSentTo,
        },
      )
    if (!recorded) {
      yield* Effect.logWarning(
        "Public-completion delivery receipt did not match an invitation attempt",
        { attemptId },
      )
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning("Failed to record public-completion delivery receipt", {
        attemptId,
        error: String(error),
      }),
    ),
  )
}

/**
 * Handler for notification-delivery queue jobs.
 *
 * This slice intentionally uses normal queue acknowledgement and retry behavior
 * rather than completed_job idempotency markers.
 */
const handleNotificationDelivery = Effect.fn("notification-delivery")(
  (job: Job<NotificationDeliveryPayload>) =>
    Effect.gen(function* () {
      const emailSender = yield* EmailSender
      const config = yield* NotificationDeliveryConfig

      const frontendBaseUrl = config.getFrontendBaseUrl()
      const environment = config.getEnvironment()
      const senderIdentity = config.getSenderIdentity()
      const payloadContext = isTaskAssignmentPayload(job.payload)
        ? { todoId: job.payload.todo.todoId }
        : isCorrectionRequiredPayload(job.payload)
          ? {
              todoId: job.payload.correctionRequired.todoId,
              correctionRequired: true,
            }
          : isPublicTodoPayload(job.payload)
            ? { todoId: job.payload.publicTodo.todoId, publicTodo: true }
            : isAccessReviewControlPayload(job.payload)
              ? {
                  failureCategory:
                    job.payload.accessReviewControl.failureCategory,
                  ...(job.payload.accessReviewControl.executionId !== undefined
                    ? {
                        executionId:
                          job.payload.accessReviewControl.executionId,
                      }
                    : {}),
                  ...(job.payload.accessReviewControl.todoId !== undefined
                    ? { todoId: job.payload.accessReviewControl.todoId }
                    : {}),
                }
              : isExecutionFailurePayload(job.payload)
                ? { executionId: job.payload.executionFailure.executionId }
                : {}

      if (senderIdentity === undefined) {
        yield* Effect.logWarning(
          "Skipping notification email because sender identity is not configured. Configure NotificationDeliveryConfig.getSenderIdentity() in your org/job worker runtime.",
          {
            jobId: job.jobId,
            channel: job.payload.channel,
            userId: job.payload.recipient.userId,
            ...payloadContext,
            recipientEmail: job.payload.recipient.email,
          },
        )
        return
      }

      const email = isTaskAssignmentPayload(job.payload)
        ? buildTaskAssignmentEmail(job.payload, frontendBaseUrl, senderIdentity)
        : isCorrectionRequiredPayload(job.payload)
          ? buildCorrectionRequiredEmail(
              job.payload,
              frontendBaseUrl,
              senderIdentity,
            )
          : isPublicTodoPayload(job.payload)
            ? buildPublicTodoEmail(
                job.payload,
                frontendBaseUrl,
                senderIdentity,
                environment,
              )
            : isAccessReviewControlPayload(job.payload)
              ? buildAccessReviewControlEmail(
                  job.payload,
                  frontendBaseUrl,
                  senderIdentity,
                )
              : isExecutionFailurePayload(job.payload)
                ? buildExecutionFailureEmail(
                    job.payload,
                    frontendBaseUrl,
                    senderIdentity,
                  )
                : (() => {
                    throw new Error(
                      "Unsupported notification-delivery payload variant",
                    )
                  })()

      yield* Effect.log("Processing notification-delivery job", {
        jobId: job.jobId,
        channel: job.payload.channel,
        userId: job.payload.recipient.userId,
        ...payloadContext,
      })

      const receipt = yield* emailSender.send(
        email,
        job.payload.idempotencyKey === undefined
          ? undefined
          : { idempotencyKey: job.payload.idempotencyKey },
      )

      if (isPublicTodoPayload(job.payload)) {
        yield* recordPublicCompletionInvitationReceipt(job.payload, receipt)
      }

      yield* Effect.log("Delivered notification email", {
        jobId: job.jobId,
        channel: job.payload.channel,
        userId: job.payload.recipient.userId,
        ...payloadContext,
        recipientEmail: job.payload.recipient.email,
        subject: email.subject,
        ...(email.template !== undefined && { templateId: email.template.id }),
        ...(receipt !== undefined && {
          providerMessageId: receipt.providerMessageId,
          providerSentTo: receipt.providerSentTo,
        }),
      })
    }),
)

export const notificationDeliveryHandler = {
  schema: NotificationDeliveryPayloadSchema,
  handle: handleNotificationDelivery,
}
