import { HttpClient, HttpClientRequest } from "@effect/platform"
import {
  Config,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"

export interface ResendEmailTemplate {
  readonly id: string
  readonly variables?: Record<string, string | number>
}

export interface ResendApiAttachment {
  readonly filename: string
  readonly content: string
}

export interface ResendEmailRequest {
  readonly idempotencyKey?: string
  readonly to: string | readonly string[]
  readonly subject?: string
  readonly html?: string
  readonly text?: string
  readonly template?: ResendEmailTemplate
  readonly from?: string
  readonly replyTo?: string | readonly string[]
  readonly cc?: string | readonly string[]
  readonly bcc?: string | readonly string[]
  readonly headers?: Readonly<Record<string, string>>
  readonly attachments?: readonly ResendApiAttachment[]
  readonly tags?: readonly { readonly name: string; readonly value: string }[]
}

export interface ResendEmailResponse {
  readonly emailId: string
  readonly sentTo: string | readonly string[]
}

export class ResendClientConfig extends Context.Tag(
  "@processfocus/plugin-resend/ResendClientConfig",
)<
  ResendClientConfig,
  {
    readonly apiKey: Redacted.Redacted<string>
    readonly enabled: boolean
    readonly rerouteEmail: Option.Option<string>
    readonly environment: Option.Option<string>
  }
>() {}

export class ResendClient extends Context.Tag(
  "@processfocus/plugin-resend/ResendClient",
)<
  ResendClient,
  {
    readonly sendEmail: (
      message: ResendEmailRequest,
    ) => Effect.Effect<ResendEmailResponse, ResendError, never>
  }
>() {}

const JsonValue = Schema.parseJson(Schema.Unknown)

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

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

/**
 * Runtime capability for deferred Resend delivery.
 *
 * When this service is provided (e.g. by the AWS runtime), the Resend step
 * sends the email, tags it for webhook correlation, persists tracking
 * metadata into process state, and returns a deferred result instead of
 * completing inline.
 *
 * When this service is absent (e.g. local development), the Resend step
 * keeps its current immediate-completion behavior.
 */
export class ResendDeferredDelivery extends Context.Tag(
  "@processfocus/plugin-resend/ResendDeferredDelivery",
)<
  ResendDeferredDelivery,
  {
    /** Environment tag for webhook correlation and metadata (e.g. "production", "staging") */
    readonly environment: string
  }
>() {}

export const ResendClientConfigFromEnv = Layer.effect(
  ResendClientConfig,
  Effect.gen(function* () {
    return {
      apiKey: yield* Config.redacted("RESEND_API_KEY"),
      enabled: yield* Config.withDefault(
        Config.boolean("RESEND_ENABLED"),
        false,
      ),
      rerouteEmail: yield* Config.option(Config.string("RESEND_REROUTE_EMAIL")),
      environment: yield* Config.option(Config.string("PF_ENV")),
    }
  }),
)

export const ResendClientLive = Layer.effect(
  ResendClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const { apiKey, enabled, rerouteEmail, environment } =
      yield* ResendClientConfig

    const sendEmail = Effect.fn("ResendClient.sendEmail")(function* (
      message: ResendEmailRequest,
    ) {
      let actualTo: string | readonly string[] = message.to
      let rerouteAddress: string | undefined

      if (!enabled) {
        if (Option.isNone(rerouteEmail)) {
          return yield* Effect.die(
            new ResendError({
              message:
                "RESEND_REROUTE_EMAIL must be set when RESEND_ENABLED is false",
            }),
          )
        }

        if (!targetsOnlyRerouteEmail(message.to, rerouteEmail.value)) {
          actualTo = rerouteEmail.value
          rerouteAddress = rerouteEmail.value
        }
      }

      const isRerouted = rerouteAddress !== undefined
      const originalTo = Array.isArray(message.to)
        ? message.to.join(", ")
        : message.to

      const templateLogDetails =
        message.template === undefined
          ? {}
          : {
              templateId: message.template.id,
              templateVariableKeys: Object.keys(
                message.template.variables ?? {},
              ),
            }

      if (isRerouted) {
        yield* Effect.log(
          `Rerouting email to ${rerouteAddress} (RESEND_ENABLED=false)`,
          {
            originalTo,
            ...(message.from !== undefined && { from: message.from }),
            ...(message.subject !== undefined && { subject: message.subject }),
            ...templateLogDetails,
          },
        )
      }

      const environmentHeaders = Option.match(environment, {
        onNone: () => ({}),
        onSome: (value) => ({ "ProcessFocus-Env": value }),
      })
      const effectiveHeaders = {
        ...message.headers,
        ...environmentHeaders,
        ...(isRerouted && {
          "ProcessFocus-Rerouted": "true",
          "ProcessFocus-Original-To": originalTo,
          "ProcessFocus-Rerouted-To": rerouteAddress,
          "ProcessFocus-Reroute-Reason": "resend_disabled",
        }),
      }
      const effectiveSubject =
        isRerouted && message.subject !== undefined
          ? `[REROUTED] ${message.subject}`
          : message.subject

      const body = {
        to: actualTo,
        ...(message.from !== undefined && { from: message.from }),
        ...(effectiveSubject !== undefined && { subject: effectiveSubject }),
        ...(message.html !== undefined && { html: message.html }),
        ...(message.text !== undefined && { text: message.text }),
        ...(message.template !== undefined && { template: message.template }),
        ...(message.replyTo !== undefined && { reply_to: message.replyTo }),
        ...(Object.keys(effectiveHeaders).length > 0 && {
          headers: effectiveHeaders,
        }),
        ...(!isRerouted && message.cc !== undefined && { cc: message.cc }),
        ...(!isRerouted && message.bcc !== undefined && { bcc: message.bcc }),
        ...(message.attachments !== undefined && {
          attachments: message.attachments,
        }),
        ...(message.tags !== undefined && { tags: message.tags }),
      }

      yield* Effect.log("Sending email via Resend", {
        to: Array.isArray(actualTo) ? actualTo.join(", ") : actualTo,
        ...(message.from !== undefined && { from: message.from }),
        ...(effectiveSubject !== undefined && { subject: effectiveSubject }),
        ...templateLogDetails,
      })

      let request = HttpClientRequest.post("https://api.resend.com/emails")
      request = HttpClientRequest.setHeader(
        request,
        "Authorization",
        `Bearer ${Redacted.value(apiKey)}`,
      )
      if (message.idempotencyKey !== undefined) {
        request = HttpClientRequest.setHeader(
          request,
          "Idempotency-Key",
          message.idempotencyKey,
        )
      }
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(
          (cause) =>
            new ResendError({
              message: "Failed to serialize request body",
              cause,
            }),
        ),
      )

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new ResendError({
              message: "Failed to send email",
              cause,
            }),
        ),
      )

      if (response.status < 200 || response.status >= 300) {
        const errorBody = yield* response.text.pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )

        return yield* new ResendError({
          message: `Resend API error (${response.status}): ${getResendErrorDetail(errorBody)}`,
        })
      }

      const responseBody = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new ResendError({
              message: "Failed to read Resend response body",
              cause,
            }),
        ),
      )

      yield* Effect.log("Resend API response received", {
        status: response.status,
        responseLength: responseBody.length,
      })

      const result = yield* Schema.decodeUnknown(JsonValue)(responseBody).pipe(
        Effect.map((value) => value as { id?: string }),
        Effect.mapError(
          (cause) =>
            new ResendError({
              message: "Failed to parse Resend response",
              cause,
            }),
        ),
      )

      if (result.id === undefined) {
        return yield* new ResendError({
          message: `Resend response missing id field: ${responseBody.slice(0, 200)}`,
        })
      }

      yield* Effect.log("Email sent successfully via Resend", {
        emailId: result.id,
      })

      return { emailId: result.id, sentTo: actualTo }
    })

    return { sendEmail }
  }),
)

export class ResendError extends Data.TaggedError("ResendError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const getResendErrorDetail = (errorBody: string): string => {
  if (errorBody.length === 0) {
    return "empty response"
  }

  try {
    const parsed = Schema.decodeUnknownSync(JsonValue)(errorBody) as {
      readonly message?: string
    }

    return parsed.message ?? errorBody
  } catch {
    return errorBody
  }
}
