import { Context, Data, Effect, Layer } from "effect"

export const SERVER_PLUGIN_HOST_INTERFACE_VERSION = 1

/** Type-erased executable Layer; Layer's provided-service parameter is contravariant. */
export type ServerPluginJobLayer = Layer.Layer<never, unknown, unknown>

/** A provider-neutral view of state persisted for a deferred Todo. */
export interface DeferredTodoSnapshot {
  readonly state: Record<string, unknown>
}

export type WebhookCallbackResult =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Ignored" }

export type PublicCompletionDeliveryCallback =
  | {
      readonly status: "delivered"
      readonly deliveryId: string
      readonly todoId: string
      readonly invitationAttemptId: string
      readonly providerMessageId?: string
    }
  | {
      readonly status: "failed"
      readonly deliveryId: string
      readonly todoId: string
      readonly invitationAttemptId: string
      readonly providerMessageId?: string
      readonly failureKind: "recipient_address" | "provider_transport"
      readonly failureReason: string
      readonly failureDetails?: Readonly<Record<string, string>>
    }

export class WebhookCallbackError extends Data.TaggedError(
  "WebhookCallbackError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Provider-neutral process callbacks exposed by runtime hosts to organisation
 * webhook handlers. Provider parsing and correlation remain plugin concerns.
 */
export class WebhookCallbackHost extends Context.Tag(
  "@processfocus/runtime/WebhookCallbackHost",
)<
  WebhookCallbackHost,
  {
    readonly lookupDeferredTodo: (
      todoId: string,
    ) => Effect.Effect<DeferredTodoSnapshot | null, WebhookCallbackError>
    readonly completeDeferredTodo: (input: {
      readonly todoId: string
      readonly callbackId: string
      readonly output: Record<string, unknown>
    }) => Effect.Effect<WebhookCallbackResult, WebhookCallbackError>
    readonly failDeferredTodo: (input: {
      readonly todoId: string
      readonly callbackId: string
      readonly failureReason: string
      readonly errorTag?: string
    }) => Effect.Effect<WebhookCallbackResult, WebhookCallbackError>
    readonly applyPublicCompletionCallback: (
      callback: PublicCompletionDeliveryCallback,
    ) => Effect.Effect<WebhookCallbackResult, WebhookCallbackError>
  }
>() {}

export interface WebhookDescriptor {
  readonly path: string
  readonly handle: (
    request: Request,
  ) => Effect.Effect<Response, never, WebhookCallbackHost>
}

/** Registration supplied by an organisation's bundled server plugin. */
export interface ServerPluginRegistration {
  readonly identity: string
  readonly hostInterfaceVersion: typeof SERVER_PLUGIN_HOST_INTERFACE_VERSION
  readonly jobLayer?: ServerPluginJobLayer
  readonly webhooks?: readonly WebhookDescriptor[]
}

export class ServerPluginContractError extends Data.TaggedError(
  "ServerPluginContractError",
)<{
  readonly message: string
  readonly pluginIdentity?: string
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isWebhookHandler = (
  value: unknown,
): value is WebhookDescriptor["handle"] => typeof value === "function"

const parseWebhook = (
  value: unknown,
  identity: string,
  index: number,
): Effect.Effect<WebhookDescriptor, ServerPluginContractError> => {
  if (!isRecord(value)) {
    return Effect.fail(
      new ServerPluginContractError({
        message: `server plugin "${identity}" webhook ${index} must be an object`,
        pluginIdentity: identity,
      }),
    )
  }

  const path = value["path"]
  if (
    typeof path !== "string" ||
    !/^\/webhooks\/[A-Za-z0-9](?:[A-Za-z0-9._~/-]*[A-Za-z0-9._~-])?$/.test(
      path,
    ) ||
    path.includes("//")
  ) {
    return Effect.fail(
      new ServerPluginContractError({
        message: `server plugin "${identity}" webhook ${index} path must be an absolute /webhooks/... path`,
        pluginIdentity: identity,
      }),
    )
  }

  const handle = value["handle"]
  if (!isWebhookHandler(handle)) {
    return Effect.fail(
      new ServerPluginContractError({
        message: `server plugin "${identity}" webhook "${path}" must provide handle(request)`,
        pluginIdentity: identity,
      }),
    )
  }

  return Effect.succeed({ path, handle })
}

const parseRegistration = (
  value: unknown,
  index: number,
): Effect.Effect<ServerPluginRegistration, ServerPluginContractError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new ServerPluginContractError({
        message: `server plugin registration ${index} must be an object`,
      })
    }

    const identity = value["identity"]
    if (typeof identity !== "string" || identity.trim().length === 0) {
      return yield* new ServerPluginContractError({
        message: `server plugin registration ${index} identity must be a non-empty string`,
      })
    }

    const hostInterfaceVersion = value["hostInterfaceVersion"]
    if (hostInterfaceVersion !== SERVER_PLUGIN_HOST_INTERFACE_VERSION) {
      return yield* new ServerPluginContractError({
        message: `server plugin "${identity}" requires host interface ${JSON.stringify(hostInterfaceVersion)} but this runtime provides ${SERVER_PLUGIN_HOST_INTERFACE_VERSION}`,
        pluginIdentity: identity,
      })
    }

    const jobLayer = value["jobLayer"]
    if (jobLayer !== undefined && !Layer.isLayer(jobLayer)) {
      return yield* new ServerPluginContractError({
        message: `server plugin "${identity}" jobLayer must be an Effect Layer`,
        pluginIdentity: identity,
      })
    }

    const rawWebhooks = value["webhooks"]
    if (rawWebhooks !== undefined && !Array.isArray(rawWebhooks)) {
      return yield* new ServerPluginContractError({
        message: `server plugin "${identity}" webhooks must be an array`,
        pluginIdentity: identity,
      })
    }

    const webhooks: WebhookDescriptor[] = []
    for (const [webhookIndex, webhook] of (rawWebhooks ?? []).entries()) {
      webhooks.push(yield* parseWebhook(webhook, identity, webhookIndex))
    }

    return {
      identity,
      hostInterfaceVersion,
      ...(jobLayer !== undefined && { jobLayer }),
      ...(rawWebhooks !== undefined && { webhooks }),
    }
  })

/** Validate the executable server registrations exported by an org module. */
export const parseServerPluginRegistrations = (
  value: unknown,
): Effect.Effect<
  readonly ServerPluginRegistration[],
  ServerPluginContractError
> =>
  Effect.gen(function* () {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      return yield* new ServerPluginContractError({
        message: "ServerPlugins must be an array",
      })
    }

    const registrations: ServerPluginRegistration[] = []
    const identities = new Set<string>()
    const webhookOwners = new Map<string, string>()

    for (const [index, item] of value.entries()) {
      const registration = yield* parseRegistration(item, index)
      if (identities.has(registration.identity)) {
        return yield* new ServerPluginContractError({
          message: `duplicate server plugin identity "${registration.identity}"`,
          pluginIdentity: registration.identity,
        })
      }
      identities.add(registration.identity)

      for (const webhook of registration.webhooks ?? []) {
        const owner = webhookOwners.get(webhook.path)
        if (owner !== undefined) {
          return yield* new ServerPluginContractError({
            message: `server plugin webhook path "${webhook.path}" is registered by both "${owner}" and "${registration.identity}"`,
            pluginIdentity: registration.identity,
          })
        }
        webhookOwners.set(webhook.path, registration.identity)
      }

      registrations.push(registration)
    }

    return registrations
  })

export const findWebhookDescriptor = (
  registrations: readonly ServerPluginRegistration[],
  path: string,
): WebhookDescriptor | undefined => {
  for (const registration of registrations) {
    const webhook = registration.webhooks?.find(
      (candidate) => candidate.path === path,
    )
    if (webhook !== undefined) return webhook
  }
  return undefined
}

/** Dispatch a webhook request through an organisation's registered plugin seam. */
export const dispatchServerPluginWebhook = ({
  request,
  registrations,
  callbackHost,
}: {
  readonly request: Request
  readonly registrations: readonly ServerPluginRegistration[]
  readonly callbackHost: WebhookCallbackHost["Type"]
}): Effect.Effect<Response> => {
  const descriptor = findWebhookDescriptor(
    registrations,
    new URL(request.url).pathname,
  )
  if (descriptor === undefined) {
    return Effect.succeed(new Response("Not Found", { status: 404 }))
  }
  return descriptor
    .handle(request)
    .pipe(Effect.provideService(WebhookCallbackHost, callbackHost))
}

export const getServerPluginJobLayers = (
  registrations: readonly ServerPluginRegistration[],
): readonly ServerPluginJobLayer[] =>
  registrations.flatMap((registration) =>
    registration.jobLayer === undefined ? [] : [registration.jobLayer],
  )

export const makeServerPluginJobLayer = (
  registrations: readonly ServerPluginRegistration[],
): ServerPluginJobLayer => {
  const layers = getServerPluginJobLayers(registrations)
  return layers.reduce<ServerPluginJobLayer>(
    (combined, layer) => Layer.merge(combined, layer),
    Layer.empty,
  )
}
