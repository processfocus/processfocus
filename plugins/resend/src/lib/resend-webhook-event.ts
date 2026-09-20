import { createHmac, timingSafeEqual } from "node:crypto"
import { Data, Effect, Schema } from "effect"

export const SVIX_ID_HEADER = "svix-id"
export const SVIX_TIMESTAMP_HEADER = "svix-timestamp"
export const SVIX_SIGNATURE_HEADER = "svix-signature"
export const SVIX_TOLERANCE_SECONDS = 5 * 60

export const RESEND_TODO_TAG_NAME = "pf_todo_id"
export const RESEND_ENVIRONMENT_TAG_NAME = "pf_environment"
export const RESEND_PUBLIC_COMPLETION_TODO_TAG_NAME =
  "pf_public_completion_todo_id"
export const RESEND_PUBLIC_COMPLETION_ENVIRONMENT_TAG_NAME =
  "pf_public_completion_environment"
export const RESEND_PUBLIC_COMPLETION_INVITATION_ATTEMPT_TAG_NAME =
  "pf_public_completion_invitation_attempt_id"

const JsonValue = Schema.parseJson(Schema.Unknown)

const RESEND_FAILURE_EVENT_TYPES = [
  "email.failed",
  "email.bounced",
  "email.suppressed",
] as const

export type ResendFailureEventType = (typeof RESEND_FAILURE_EVENT_TYPES)[number]

export type ResendDeliveryFailureKind =
  | "recipient_address"
  | "provider_transport"

interface ResendWebhookPayload {
  readonly type?: unknown
  readonly data?: {
    readonly email_id?: unknown
    readonly to?: unknown
    readonly tags?: unknown
    readonly bounce?: unknown
    readonly failed?: unknown
    readonly suppressed?: unknown
  }
}

export interface ResendFailure {
  readonly failureReason: string
  readonly errorTag: ResendFailureEventType
  readonly failureKind: ResendDeliveryFailureKind
  readonly details?: Readonly<Record<string, string>>
}

export interface ParsedResendWebhookEvent {
  readonly deliveryId: string
  readonly eventType: unknown
  readonly emailId?: string
  readonly recipients: readonly string[]
  readonly delivered: boolean
  readonly failure: ResendFailure | null
  readonly deferredTodo?: {
    readonly todoId: string
    readonly environment?: string
  }
  readonly publicCompletion?: {
    readonly todoId: string
    readonly environment?: string
    readonly invitationAttemptId?: string
  }
}

export interface SvixHeaderValues {
  readonly id: string
  readonly timestamp: string
  readonly signatureHeader: string
}

export class InvalidResendWebhookPayloadError extends Data.TaggedError(
  "InvalidResendWebhookPayloadError",
)<{
  readonly cause?: unknown
}> {}

export const isResendWebhookRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normalizeResendEmail = (email: string): string =>
  email.trim().toLowerCase()

const constantTimeEqual = (a: string, b: string): boolean => {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

const getResendWebhookSecretBytes = (secret: string): Buffer => {
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret
  return Buffer.from(encodedSecret, "base64")
}

const getSignatureCandidates = (header: string): string[] =>
  header
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [version, signature] = part.split(",", 2)
      return version === "v1" && signature ? [signature] : []
    })

export const getSvixHeaderValues = (
  headers: Headers,
): SvixHeaderValues | null => {
  const id = headers.get(SVIX_ID_HEADER)
  const timestamp = headers.get(SVIX_TIMESTAMP_HEADER)
  const signatureHeader = headers.get(SVIX_SIGNATURE_HEADER)

  if (!id || !timestamp || !signatureHeader) {
    return null
  }

  return { id, timestamp, signatureHeader }
}

const parseTimestampSeconds = (timestamp: string): number | null => {
  if (!/^\d+$/.test(timestamp)) {
    return null
  }

  const parsed = Number.parseInt(timestamp, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export const signResendWebhookPayload = (params: {
  readonly payload: string
  readonly webhookSecret: string
  readonly deliveryId: string
  readonly timestamp: string
}): string =>
  createHmac("sha256", getResendWebhookSecretBytes(params.webhookSecret))
    .update(`${params.deliveryId}.${params.timestamp}.${params.payload}`)
    .digest("base64")

export const makeResendWebhookHeaders = (params: {
  readonly payload: string
  readonly webhookSecret: string
  readonly deliveryId: string
  readonly timestamp: string
  readonly contentType?: string
}): Headers => {
  const signature = signResendWebhookPayload(params)
  return new Headers({
    "Content-Type": params.contentType ?? "application/json",
    [SVIX_ID_HEADER]: params.deliveryId,
    [SVIX_TIMESTAMP_HEADER]: params.timestamp,
    [SVIX_SIGNATURE_HEADER]: `v1,${signature}`,
  })
}

export const verifyResendWebhookSignature = (params: {
  readonly payload: string
  readonly headers: Headers
  readonly webhookSecret: string
  readonly now?: number
  readonly toleranceSeconds?: number
}): boolean => {
  const svixHeaders = getSvixHeaderValues(params.headers)
  if (!svixHeaders) {
    return false
  }

  const timestampSeconds = parseTimestampSeconds(svixHeaders.timestamp)
  if (timestampSeconds === null) {
    return false
  }

  const toleranceSeconds = params.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS
  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false
  }

  const expectedSignature = signResendWebhookPayload({
    payload: params.payload,
    webhookSecret: params.webhookSecret,
    deliveryId: svixHeaders.id,
    timestamp: svixHeaders.timestamp,
  })

  return getSignatureCandidates(svixHeaders.signatureHeader).some((signature) =>
    constantTimeEqual(signature, expectedSignature),
  )
}

const extractStringTag = (tags: unknown, name: string): string | undefined => {
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!isResendWebhookRecord(tag)) continue
      if (tag["name"] === name && typeof tag["value"] === "string") {
        return tag["value"]
      }
    }
    return undefined
  }

  if (isResendWebhookRecord(tags) && typeof tags[name] === "string") {
    return tags[name]
  }

  return undefined
}

const extractRecipients = (to: unknown): readonly string[] => {
  if (typeof to === "string") {
    return [normalizeResendEmail(to)]
  }

  if (Array.isArray(to)) {
    return to
      .filter((value): value is string => typeof value === "string")
      .map(normalizeResendEmail)
  }

  return []
}

const extractEmailId = (payload: ResendWebhookPayload): string | undefined =>
  typeof payload.data?.email_id === "string" ? payload.data.email_id : undefined

const extractFailureDetails = (
  payload: ResendWebhookPayload,
): Readonly<Record<string, string>> | undefined => {
  const failed = payload.data?.failed
  if (isResendWebhookRecord(failed)) {
    const details: Record<string, string> = {}
    if (typeof failed["reason"] === "string") {
      details["failureReasonDetail"] = failed["reason"]
    }
    if (typeof failed["recipient"] === "string") {
      details["recipient"] = failed["recipient"]
    }
    return Object.keys(details).length > 0 ? details : undefined
  }

  const bounce = payload.data?.bounce
  if (isResendWebhookRecord(bounce)) {
    const details: Record<string, string> = {}

    if (typeof bounce["type"] === "string") {
      details["bounceType"] = bounce["type"]
    }
    if (typeof bounce["subType"] === "string") {
      details["bounceSubType"] = bounce["subType"]
    }
    if (typeof bounce["message"] === "string") {
      details["bounceMessage"] = bounce["message"]
    }

    return Object.keys(details).length > 0 ? details : undefined
  }

  const suppressed = payload.data?.suppressed
  if (isResendWebhookRecord(suppressed)) {
    const details: Record<string, string> = {}
    if (typeof suppressed["reason"] === "string") {
      details["suppressionReason"] = suppressed["reason"]
    }
    if (typeof suppressed["recipient"] === "string") {
      details["recipient"] = suppressed["recipient"]
    }
    return Object.keys(details).length > 0 ? details : undefined
  }

  return undefined
}

const extractFailedReason = (payload: ResendWebhookPayload) => {
  const failed = payload.data?.failed
  if (!isResendWebhookRecord(failed)) {
    return undefined
  }

  return typeof failed["reason"] === "string" ? failed["reason"] : undefined
}

const normalizeReasonToken = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_")

const RECIPIENT_FAILED_REASONS = new Set([
  "bad_destination_mailbox_address",
  "hard_bounce",
  "invalid_email",
  "invalid_recipient",
  "mailbox_not_found",
  "no_email",
  "recipient_not_found",
  "recipient_rejected",
  "suppressed",
  "user_unknown",
])

const classifyFailureKind = (
  eventType: ResendFailureEventType,
  details: Readonly<Record<string, string>> | undefined,
  failedReason: string | undefined,
): ResendDeliveryFailureKind => {
  const failedReasonToken = normalizeReasonToken(failedReason)
  if (RECIPIENT_FAILED_REASONS.has(failedReasonToken)) {
    return "recipient_address"
  }

  // Resend's structured failed.reason is the canonical provider reason. Other
  // detail fields can be labels, so scan them only when reason is absent.
  if (eventType === "email.failed" && failedReason !== undefined) {
    return "provider_transport"
  }

  const detailTokens = new Set(
    Object.values(details ?? {}).map((value) => normalizeReasonToken(value)),
  )

  for (const token of detailTokens) {
    if (RECIPIENT_FAILED_REASONS.has(token)) {
      return "recipient_address"
    }
  }

  if (eventType === "email.bounced") {
    const bounceType = normalizeReasonToken(details?.["bounceType"])
    return bounceType === "hard" || bounceType === "permanent"
      ? "recipient_address"
      : "provider_transport"
  }

  if (eventType === "email.suppressed") {
    return "recipient_address"
  }

  return "provider_transport"
}

const getFailureForEventType = (
  payload: ResendWebhookPayload,
): ResendFailure | null => {
  if (
    !RESEND_FAILURE_EVENT_TYPES.includes(payload.type as ResendFailureEventType)
  ) {
    return null
  }

  const errorTag = payload.type as ResendFailureEventType
  const details = extractFailureDetails(payload)
  const failedReason = extractFailedReason(payload)
  return {
    failureReason: `Resend reported ${errorTag}`,
    errorTag,
    failureKind: classifyFailureKind(errorTag, details, failedReason),
    ...(details !== undefined && { details }),
  }
}

export const decodeResendWebhookPayload = (
  rawBody: string,
): Effect.Effect<ResendWebhookPayload, InvalidResendWebhookPayloadError> =>
  Schema.decodeUnknown(JsonValue)(rawBody).pipe(
    Effect.map((value) => value as ResendWebhookPayload),
    Effect.mapError(
      (error) => new InvalidResendWebhookPayloadError({ cause: error }),
    ),
  )

export const parseResendWebhookEvent = (params: {
  readonly deliveryId: string
  readonly payload: ResendWebhookPayload
}): ParsedResendWebhookEvent => {
  const emailId = extractEmailId(params.payload)
  const tags = params.payload.data?.tags
  const deferredTodoId = extractStringTag(tags, RESEND_TODO_TAG_NAME)
  const publicCompletionTodoId = extractStringTag(
    tags,
    RESEND_PUBLIC_COMPLETION_TODO_TAG_NAME,
  )
  const publicCompletionInvitationAttemptId = extractStringTag(
    tags,
    RESEND_PUBLIC_COMPLETION_INVITATION_ATTEMPT_TAG_NAME,
  )
  const publicCompletionEnvironment = extractStringTag(
    tags,
    RESEND_PUBLIC_COMPLETION_ENVIRONMENT_TAG_NAME,
  )
  const deferredEnvironment = extractStringTag(
    tags,
    RESEND_ENVIRONMENT_TAG_NAME,
  )

  return {
    deliveryId: params.deliveryId,
    eventType: params.payload.type,
    recipients: extractRecipients(params.payload.data?.to),
    delivered: params.payload.type === "email.delivered",
    failure: getFailureForEventType(params.payload),
    ...(emailId !== undefined && { emailId }),
    ...(deferredTodoId !== undefined && {
      deferredTodo: {
        todoId: deferredTodoId,
        ...(deferredEnvironment !== undefined && {
          environment: deferredEnvironment,
        }),
      },
    }),
    ...(publicCompletionTodoId !== undefined && {
      publicCompletion: {
        todoId: publicCompletionTodoId,
        ...(publicCompletionEnvironment !== undefined && {
          environment: publicCompletionEnvironment,
        }),
        ...(publicCompletionInvitationAttemptId !== undefined && {
          invitationAttemptId: publicCompletionInvitationAttemptId,
        }),
      },
    }),
  }
}
