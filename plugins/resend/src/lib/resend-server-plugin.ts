import {
  type ConfigurationGroup,
  SERVER_PLUGIN_HOST_INTERFACE_VERSION,
  type ServerPluginJobLayer,
  type ServerPluginRegistration,
  WebhookCallbackHost,
  readConfiguration,
} from "@processfocus/runtime"
import { Data, Effect, Layer, Option, Redacted, Result } from "effect"
import {
  ResendClientConfigFromEnv,
  ResendClientLive,
  ResendDeferredDelivery,
} from "./resend-client"
import {
  ResendConfiguration,
  ResendDeferredDeliveryConfiguration,
  ResendWebhookConfiguration,
  makeResendWebhookConfiguration,
} from "./resend-configuration"
import {
  decodeResendWebhookPayload,
  getSvixHeaderValues,
  isResendWebhookRecord,
  normalizeResendEmail,
  parseResendWebhookEvent,
  verifyResendWebhookSignature,
} from "./resend-webhook-event"

export const RESEND_WEBHOOK_PATH = "/webhooks/resend"

interface ResendWebhookLogContext {
  readonly deliveryId: string
  readonly eventType: unknown
  readonly emailId?: string
  readonly todoId?: string
  readonly webhookEnvironment?: string
  readonly recipients?: readonly string[]
}

interface StoredResendMetadata {
  readonly emailId: string
  readonly primaryTo: string
  readonly environment: string
}

class InvalidRequestBodyError extends Data.TaggedError(
  "InvalidRequestBodyError",
)<{
  readonly cause?: unknown
}> {}

const textResponse = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })

const okResponse = () => textResponse(200, "ok")

const retryableResponse = (body: string) =>
  new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "5",
    },
  })

const getStoredResendMetadata = (
  state: Record<string, unknown>,
): StoredResendMetadata | null => {
  const internal = state["_internal"]
  if (!isResendWebhookRecord(internal)) return null

  const resend = internal["resend"]
  if (!isResendWebhookRecord(resend)) return null

  const emailId = resend["emailId"]
  const primaryTo = resend["primaryTo"]
  const environment = resend["environment"]
  if (
    typeof emailId !== "string" ||
    typeof primaryTo !== "string" ||
    typeof environment !== "string"
  ) {
    return null
  }

  return { emailId, primaryTo, environment }
}

const getWebhookConfig = readConfiguration(ResendWebhookConfiguration).pipe(
  Effect.map(({ webhookSecret, environment }) => ({
    webhookSecret: Option.map(webhookSecret, Redacted.value).pipe(
      Option.getOrUndefined,
    ),
    environment,
  })),
)

/** Provider-owned Resend callback behavior behind generic host callbacks. */
export const handleResendWebhookRequest = (
  request: Request,
): Effect.Effect<Response, never, WebhookCallbackHost> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return textResponse(405, "Method Not Allowed")
    }

    const callbacks = yield* WebhookCallbackHost
    const config = yield* getWebhookConfig.pipe(
      Effect.catchTag("ConfigurationError", () =>
        Effect.succeed({ webhookSecret: undefined, environment: "local" }),
      ),
    )
    if (!config.webhookSecret) {
      yield* Effect.logError("RESEND_WEBHOOK_SECRET is not configured")
      return textResponse(503, "Resend webhook secret is not configured")
    }

    const svixHeaders = getSvixHeaderValues(request.headers)
    if (!svixHeaders) {
      return textResponse(400, "Missing webhook signature headers")
    }

    const rawBodyResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => request.text(),
        catch: (cause) => new InvalidRequestBodyError({ cause }),
      }),
    )
    if (Result.isFailure(rawBodyResult)) {
      yield* Effect.logError("Failed to read Resend webhook request body", {
        error: String(rawBodyResult.failure),
      })
      return textResponse(400, "Invalid request body")
    }
    const rawBody = rawBodyResult.success

    if (
      !verifyResendWebhookSignature({
        payload: rawBody,
        headers: request.headers,
        webhookSecret: config.webhookSecret,
      })
    ) {
      return textResponse(401, "Invalid webhook signature")
    }

    const deliveryId = svixHeaders.id
    const payloadResult = yield* Effect.result(
      decodeResendWebhookPayload(rawBody),
    )
    if (Result.isFailure(payloadResult)) {
      yield* Effect.logError("Failed to parse Resend webhook payload", {
        error: String(payloadResult.failure),
      })
      return textResponse(400, "Invalid JSON payload")
    }

    const event = parseResendWebhookEvent({
      deliveryId,
      payload: payloadResult.success,
    })
    const webhookEnvironment =
      event.publicCompletion?.environment ?? event.deferredTodo?.environment
    const logContext: ResendWebhookLogContext = {
      deliveryId,
      eventType: event.eventType,
      ...(event.emailId !== undefined && { emailId: event.emailId }),
      ...(webhookEnvironment !== undefined && { webhookEnvironment }),
      ...(event.recipients.length > 0 && { recipients: event.recipients }),
    }

    if (event.publicCompletion !== undefined) {
      const publicCompletion = event.publicCompletion
      if (publicCompletion.environment === undefined) {
        yield* Effect.logInfo(
          "Ignoring public-completion Resend webhook without environment tag",
          {
            ...logContext,
            todoId: publicCompletion.todoId,
            invitationAttemptId: publicCompletion.invitationAttemptId,
            expectedEnvironment: config.environment,
          },
        )
        return okResponse()
      }

      if (publicCompletion.environment !== config.environment) {
        yield* Effect.logInfo(
          "Ignoring public-completion Resend webhook for a different environment",
          {
            ...logContext,
            todoId: publicCompletion.todoId,
            invitationAttemptId: publicCompletion.invitationAttemptId,
            expectedEnvironment: config.environment,
          },
        )
        return okResponse()
      }

      if (publicCompletion.invitationAttemptId === undefined) {
        yield* Effect.logInfo(
          "Ignoring public-completion Resend webhook without invitation attempt tag",
          { ...logContext, todoId: publicCompletion.todoId },
        )
        return okResponse()
      }

      if (!event.delivered && event.failure === null) {
        yield* Effect.logInfo(
          "Ignoring non-terminal public-completion Resend webhook event",
          {
            ...logContext,
            todoId: publicCompletion.todoId,
            invitationAttemptId: publicCompletion.invitationAttemptId,
          },
        )
        return okResponse()
      }

      if (event.delivered) {
        yield* callbacks.applyPublicCompletionCallback({
          status: "delivered",
          deliveryId,
          todoId: publicCompletion.todoId,
          invitationAttemptId: publicCompletion.invitationAttemptId,
          ...(event.emailId !== undefined && {
            providerMessageId: event.emailId,
          }),
        })
      } else if (event.failure !== null) {
        yield* callbacks.applyPublicCompletionCallback({
          status: "failed",
          deliveryId,
          todoId: publicCompletion.todoId,
          invitationAttemptId: publicCompletion.invitationAttemptId,
          ...(event.emailId !== undefined && {
            providerMessageId: event.emailId,
          }),
          failureKind: event.failure.failureKind,
          failureReason: event.failure.failureReason,
          ...(event.failure.details !== undefined && {
            failureDetails: event.failure.details,
          }),
        })
      }

      return okResponse()
    }

    if (event.deferredTodo?.environment !== config.environment) {
      yield* Effect.logInfo(
        "Ignoring Resend webhook for a different environment",
        { ...logContext, expectedEnvironment: config.environment },
      )
      return okResponse()
    }

    const todoId = event.deferredTodo?.todoId
    if (!todoId) {
      yield* Effect.logInfo(
        "Ignoring Resend webhook without todo correlation tag",
        logContext,
      )
      return okResponse()
    }

    if (!event.delivered && event.failure === null) {
      yield* Effect.logInfo("Ignoring non-terminal Resend webhook event", {
        ...logContext,
        todoId,
      })
      return okResponse()
    }

    const snapshot = yield* callbacks.lookupDeferredTodo(todoId)
    if (!snapshot) {
      yield* Effect.logInfo(
        "Resend webhook todo not found, skipping callback",
        {
          ...logContext,
          todoId,
        },
      )
      return okResponse()
    }

    const metadata = getStoredResendMetadata(snapshot.state)
    if (!metadata) {
      yield* Effect.logWarning(
        "Resend webhook todo has no deferred Resend metadata yet, requesting retry",
        { ...logContext, todoId },
      )
      return retryableResponse(
        "Deferred Resend metadata not persisted yet; retry webhook",
      )
    }

    if (metadata.environment !== config.environment) {
      yield* Effect.logInfo(
        "Ignoring Resend webhook because stored metadata environment differs",
        {
          ...logContext,
          todoId,
          storedEnvironment: metadata.environment,
          expectedEnvironment: config.environment,
        },
      )
      return okResponse()
    }

    const primaryRecipient = normalizeResendEmail(metadata.primaryTo)
    if (!event.recipients.includes(primaryRecipient)) {
      yield* Effect.logWarning(
        "Ignoring Resend webhook because recipients do not include the stored primary recipient",
        {
          ...logContext,
          todoId,
          primaryRecipient,
          storedEmailId: metadata.emailId,
        },
      )
      return okResponse()
    }

    if (event.delivered) {
      yield* Effect.logInfo(
        "Completing deferred Resend todo from delivery webhook",
        {
          ...logContext,
          todoId,
          primaryRecipient,
          storedEmailId: metadata.emailId,
        },
      )
      const result = yield* callbacks.completeDeferredTodo({
        todoId,
        callbackId: deliveryId,
        output: { emailId: metadata.emailId },
      })
      if (result._tag === "Ignored") {
        yield* Effect.log(
          "Resend webhook delivery already completed, skipping duplicate callback",
          { deliveryId, todoId, emailId: metadata.emailId },
        )
      }
    } else if (event.failure !== null) {
      yield* Effect.logWarning(
        "Failing deferred Resend todo from failure webhook",
        {
          ...logContext,
          todoId,
          primaryRecipient,
          storedEmailId: metadata.emailId,
          failureReason: event.failure.failureReason,
          ...event.failure.details,
        },
      )
      yield* callbacks.failDeferredTodo({
        todoId,
        callbackId: deliveryId,
        failureReason: event.failure.failureReason,
        errorTag: event.failure.errorTag,
      })
    }

    return okResponse()
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to process Resend webhook", { cause }).pipe(
        Effect.as(textResponse(500, "Failed to process webhook")),
      ),
    ),
  )

/** The same executable configuration is used by worker wiring and preflight. */
export const makeResendDeferredDeliveryFromEnv = (
  configuration = ResendDeferredDeliveryConfiguration,
) =>
  Layer.unwrap(
    readConfiguration(configuration).pipe(
      Effect.map(({ waitForDelivery, environment }) =>
        waitForDelivery
          ? Layer.succeed(ResendDeferredDelivery, { environment })
          : Layer.empty,
      ),
    ),
  )

export const ResendDeferredDeliveryFromEnv = makeResendDeferredDeliveryFromEnv()

export const ResendServerPluginJobLayer = Layer.merge(
  Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
  ResendDeferredDeliveryFromEnv,
)

export const makeResendServerPlugin = (options?: {
  readonly jobLayer?: ServerPluginJobLayer
  readonly configuration?: readonly ConfigurationGroup[]
  readonly deliveryConfiguration?: typeof ResendDeferredDeliveryConfiguration
}): ServerPluginRegistration & {
  readonly configuration: readonly ConfigurationGroup[]
} => ({
  identity: "email.resend",
  hostInterfaceVersion: SERVER_PLUGIN_HOST_INTERFACE_VERSION,
  jobLayer:
    options?.jobLayer ??
    (options?.deliveryConfiguration === undefined
      ? ResendServerPluginJobLayer
      : Layer.merge(
          Layer.provideMerge(ResendClientLive, ResendClientConfigFromEnv),
          makeResendDeferredDeliveryFromEnv(options.deliveryConfiguration),
        )),
  configuration: [
    ...(options?.configuration ?? [ResendConfiguration]),
    options?.deliveryConfiguration ?? ResendDeferredDeliveryConfiguration,
    makeResendWebhookConfiguration(options?.deliveryConfiguration),
  ],
  webhooks: [
    {
      path: RESEND_WEBHOOK_PATH,
      handle: handleResendWebhookRequest,
    },
  ],
})

export const ResendServerPlugin = makeResendServerPlugin()
