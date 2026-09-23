import { randomUUID } from "node:crypto"
import { Clock, Effect, Option, Schema } from "effect"
import {
  ProviderUserSessionSchema,
  getRealtimeRecipientId,
} from "@pf/auth-session"
import { CliError } from "../errors"

// WebSocket readyState constants (WebSocket.OPEN may not be available in all runtimes)
const WS_OPEN = 1

const EXECUTION_STATUS_VALUES = [
  "Waiting",
  "Running",
  "Completed",
  "Failed",
  "Abandoned",
] as const
const EXECUTION_STEP_STATUS_VALUES = EXECUTION_STATUS_VALUES
const EXECUTION_STATUS_SET = new Set<string>(EXECUTION_STATUS_VALUES)
const EXECUTION_STEP_STATUS_SET = new Set<string>(EXECUTION_STEP_STATUS_VALUES)

export type ExecutionStatus = (typeof EXECUTION_STATUS_VALUES)[number]
export type ExecutionStepStatus = ExecutionStatus

export interface ExecutionStepSnapshot {
  readonly name: string
  readonly path: string
  readonly status: ExecutionStepStatus
  readonly failureReason: string | null
}

export interface ExecutionSnapshot {
  readonly id: string
  readonly status: ExecutionStatus
  readonly failureReason: string | null
  readonly abandonedReason: string | null
  readonly finishedAt: string | null
  readonly steps: readonly ExecutionStepSnapshot[]
}

export interface ExecutionEventSource extends AsyncIterable<ExecutionSnapshot> {
  readonly close: () => Promise<void>
}

type ExecutionEventSourceConfig =
  | {
      readonly kind: "GRAPHQL_WS"
      readonly wsEndpoint: string
      readonly accessToken: string
    }
  | {
      readonly kind: "APPSYNC_EVENTS"
      readonly realtimeUrl: string
      readonly appSyncEventsHttpHost: string
      readonly accessToken: string
      /** Caller metadata only; recipient addressing is derived from the token. */
      readonly userId: string
    }

interface AsyncQueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void
  readonly reject: (reason?: unknown) => void
}

type GraphqlExecutionStreamData = {
  readonly streamExecution?: {
    readonly documents?: readonly ExecutionSnapshot[]
  } | null
}

type GraphqlExecutionEventPayload = {
  readonly data?: {
    readonly streamExecution?: GraphqlExecutionStreamData["streamExecution"]
  } | null
  readonly errors?: readonly unknown[]
}

type GraphqlWsConnectionAckMessage = { readonly type: "connection_ack" }
type GraphqlWsPingMessage = {
  readonly type: "ping"
  readonly payload?: unknown
}
type GraphqlWsPongMessage = {
  readonly type: "pong"
  readonly payload?: unknown
}
type GraphqlWsNextMessage = {
  readonly id: string
  readonly type: "next"
  readonly payload: GraphqlExecutionEventPayload
}
type GraphqlWsErrorMessage = {
  readonly id?: string
  readonly type: "error"
  readonly payload: unknown
}
type GraphqlWsCompleteMessage = {
  readonly id: string
  readonly type: "complete"
}

type GraphqlWsServerMessage =
  | GraphqlWsConnectionAckMessage
  | GraphqlWsPingMessage
  | GraphqlWsPongMessage
  | GraphqlWsNextMessage
  | GraphqlWsErrorMessage
  | GraphqlWsCompleteMessage

type AppSyncConnectionInitMessage = { readonly type: "connection_init" }
type AppSyncConnectionAckMessage = {
  readonly type: "connection_ack"
  readonly connectionTimeoutMs: number
}
type AppSyncConnectionErrorMessage = {
  readonly type: "connection_error"
  readonly errors: ReadonlyArray<{
    readonly errorType: string
    readonly errorCode: number
    readonly message?: string
  }>
}
type AppSyncSubscribeMessage = {
  readonly type: "subscribe"
  readonly id: string
  readonly channel: string
  readonly authorization: Record<string, string>
}
type AppSyncSubscribeSuccessMessage = {
  readonly type: "subscribe_success"
  readonly id: string
}
type AppSyncSubscribeErrorMessage = {
  readonly type: "subscribe_error"
  readonly id: string
  readonly errors: ReadonlyArray<{
    readonly errorType: string
    readonly message: string
  }>
}
type AppSyncDataMessage = {
  readonly type: "data"
  readonly id: string
  readonly event: string
}
type AppSyncKeepAliveMessage = { readonly type: "ka" }
type AppSyncErrorMessage = {
  readonly type: "error"
  readonly id?: string
  readonly errors: ReadonlyArray<{ readonly message: string }>
}

type AppSyncServerMessage =
  | AppSyncConnectionAckMessage
  | AppSyncConnectionErrorMessage
  | AppSyncSubscribeSuccessMessage
  | AppSyncSubscribeErrorMessage
  | AppSyncDataMessage
  | AppSyncKeepAliveMessage
  | AppSyncErrorMessage

const EXECUTION_STREAM_SUBSCRIPTION = /* GraphQL */ `
  subscription PfcliExecutionStream {
    streamExecution {
      documents {
        id
        status
        failureReason
        abandonedReason
        finishedAt
        steps {
          name
          path
          status
          failureReason
        }
      }
    }
  }
`

class AsyncExecutionQueue implements AsyncIterable<ExecutionSnapshot> {
  private readonly items: ExecutionSnapshot[] = []
  private readonly waiters: AsyncQueueWaiter<ExecutionSnapshot>[] = []
  private closed = false
  private failure: Error | null = null

  push(item: ExecutionSnapshot): void {
    if (this.closed || this.failure) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return
    }

    this.items.push(item)
  }

  finish(): void {
    if (this.closed || this.failure) {
      return
    }

    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return
    }

    this.failure = error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecutionSnapshot> {
    return {
      next: () => {
        if (this.failure) {
          return Promise.reject(this.failure)
        }

        const item = this.items.shift()
        if (item) {
          return Promise.resolve({ value: item, done: false })
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }

        return new Promise<IteratorResult<ExecutionSnapshot>>(
          (resolve, reject) => {
            this.waiters.push({ resolve, reject })
          },
        )
      },
    }
  }
}

const readWebSocketMessage = (rawMessage: unknown): string => {
  if (typeof rawMessage === "string") {
    return rawMessage
  }

  if (Buffer.isBuffer(rawMessage)) {
    return rawMessage.toString("utf8")
  }

  if (Array.isArray(rawMessage)) {
    return Buffer.concat(
      rawMessage.filter((part): part is Buffer => Buffer.isBuffer(part)),
    ).toString("utf8")
  }

  if (rawMessage instanceof ArrayBuffer) {
    return Buffer.from(rawMessage).toString("utf8")
  }

  return String(rawMessage)
}

const readCloseEventCode = (event: unknown): number | undefined => {
  if (
    typeof event === "object" &&
    event !== null &&
    "code" in event &&
    typeof event["code"] === "number"
  ) {
    return event["code"]
  }

  return undefined
}

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }

  if (Array.isArray(error)) {
    const message = error
      .map((entry) =>
        typeof entry === "object" && entry !== null && "message" in entry
          ? String(entry["message"])
          : String(entry),
      )
      .join(", ")
    return new Error(message)
  }

  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error["message"] === "string") {
      return new Error(error["message"])
    }
    if ("reason" in error && typeof error["reason"] === "string") {
      return new Error(error["reason"])
    }
    return new Error(JSON.stringify(error))
  }

  return new Error(String(error))
}

const isExecutionStatus = (value: unknown): value is ExecutionStatus =>
  typeof value === "string" && EXECUTION_STATUS_SET.has(value)

const isExecutionStepStatus = (value: unknown): value is ExecutionStepStatus =>
  typeof value === "string" && EXECUTION_STEP_STATUS_SET.has(value)

const normalizeExecution = (value: unknown): ExecutionSnapshot | null => {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const record = value as Record<string, unknown>
  if (
    typeof record["id"] !== "string" ||
    !isExecutionStatus(record["status"])
  ) {
    return null
  }

  const stepsValue = Array.isArray(record["steps"]) ? record["steps"] : []
  const steps = stepsValue
    .map((step): ExecutionStepSnapshot | null => {
      if (typeof step !== "object" || step === null) {
        return null
      }

      const stepRecord = step as Record<string, unknown>
      if (
        typeof stepRecord["name"] !== "string" ||
        typeof stepRecord["path"] !== "string" ||
        !isExecutionStepStatus(stepRecord["status"])
      ) {
        return null
      }

      return {
        name: stepRecord["name"],
        path: stepRecord["path"],
        status: stepRecord["status"],
        failureReason:
          typeof stepRecord["failureReason"] === "string"
            ? stepRecord["failureReason"]
            : null,
      }
    })
    .filter((step): step is ExecutionStepSnapshot => step !== null)

  return {
    id: record["id"],
    status: record["status"],
    failureReason:
      typeof record["failureReason"] === "string"
        ? record["failureReason"]
        : null,
    abandonedReason:
      typeof record["abandonedReason"] === "string"
        ? record["abandonedReason"]
        : null,
    finishedAt:
      typeof record["finishedAt"] === "string" ? record["finishedAt"] : null,
    steps,
  }
}

const encodeAppSyncAuthHeader = (auth: Record<string, string>): string => {
  const header = Buffer.from(JSON.stringify(auth))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `header-${header}`
}

class GraphqlExecutionSocket {
  private socket: WebSocket | null = null
  private subscriptionId: string | null = null

  constructor(
    private readonly config: {
      readonly wsEndpoint: string
      readonly accessToken: string
      readonly onExecution: (execution: ExecutionSnapshot) => void
      readonly onError: (error: Error) => void
      readonly onClose: () => void
      readonly onComplete: () => void
    },
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        reject(new Error("WebSocket is not available in this runtime."))
        return
      }

      this.socket = new WebSocket(
        this.config.wsEndpoint,
        "graphql-transport-ws",
      )

      let connectionSettled = false

      this.socket.addEventListener("open", () => {
        this.send({
          type: "connection_init",
          payload: { token: this.config.accessToken },
        })
      })

      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(
          readWebSocketMessage(event.data),
        ) as GraphqlWsServerMessage

        switch (message.type) {
          case "connection_ack":
            this.subscribe()
            if (!connectionSettled) {
              connectionSettled = true
              resolve()
            }
            return
          case "ping":
            this.send({ type: "pong", payload: message.payload })
            return
          case "pong":
            return
          case "next":
            if (message.id !== this.subscriptionId) {
              return
            }
            if (message.payload.errors && message.payload.errors.length > 0) {
              this.config.onError(toError(message.payload.errors))
              return
            }
            for (const execution of message.payload.data?.streamExecution
              ?.documents ?? []) {
              const normalized = normalizeExecution(execution)
              if (normalized) {
                this.config.onExecution(normalized)
              }
            }
            return
          case "error": {
            const error = toError(message.payload)
            if (!connectionSettled) {
              connectionSettled = true
              reject(error)
              return
            }
            this.config.onError(error)
            return
          }
          case "complete":
            if (message.id === this.subscriptionId) {
              this.config.onComplete()
            }
            return
        }
      })

      this.socket.addEventListener("error", (event) => {
        const normalized = toError(event)
        if (!connectionSettled) {
          connectionSettled = true
          reject(normalized)
          return
        }
        this.config.onError(normalized)
      })

      this.socket.addEventListener("close", (event) => {
        const code = readCloseEventCode(event)
        if (!connectionSettled) {
          connectionSettled = true
          reject(
            new Error(
              `GraphQL subscription socket closed unexpectedly: code=${code ?? "unknown"}`,
            ),
          )
        }
        this.config.onClose()
      })
    })
  }

  disconnect(): void {
    this.socket?.close()
    this.socket = null
  }

  private subscribe(): void {
    this.subscriptionId = randomUUID()
    this.send({
      id: this.subscriptionId,
      type: "subscribe",
      payload: {
        query: EXECUTION_STREAM_SUBSCRIPTION,
      },
    })
  }

  private send(message: {
    readonly type: "connection_init" | "pong" | "subscribe"
    readonly id?: string
    readonly payload?: unknown
  }): void {
    if (this.socket?.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }
}

class AppSyncExecutionSocket {
  private socket: WebSocket | null = null
  private subscriptionId: string | null = null

  constructor(
    private readonly config: {
      readonly realtimeUrl: string
      readonly appSyncEventsHttpHost: string
      readonly accessToken: string
      readonly recipientId: string
      readonly onExecution: (execution: ExecutionSnapshot) => void
      readonly onError: (error: Error) => void
      // Note: AppSync Events protocol does not send a clean subscription completion
      // message like graphql-ws does. Closing the connection is treated as an error.
      readonly onClose: () => void
    },
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        reject(new Error("WebSocket is not available in this runtime."))
        return
      }

      const authorization = {
        host: this.config.appSyncEventsHttpHost,
        authorization: this.config.accessToken,
      }

      const authProtocol = encodeAppSyncAuthHeader(authorization)
      this.socket = new WebSocket(this.config.realtimeUrl, [
        "aws-appsync-event-ws",
        authProtocol,
      ])

      let connectionSettled = false

      this.socket.addEventListener("open", () => {
        this.send({ type: "connection_init" })
      })

      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(
          readWebSocketMessage(event.data),
        ) as AppSyncServerMessage

        switch (message.type) {
          case "connection_ack":
            this.subscribe()
            return
          case "connection_error": {
            const firstError = message.errors[0]
            const error = new Error(
              firstError
                ? `${firstError.errorType} (${firstError.errorCode}): ${firstError.message ?? "No message"}`
                : "AppSync connection failed",
            )
            if (!connectionSettled) {
              connectionSettled = true
              reject(error)
              return
            }
            this.config.onError(error)
            return
          }
          case "subscribe_success":
            if (!connectionSettled) {
              connectionSettled = true
              resolve()
            }
            return
          case "subscribe_error": {
            const firstError = message.errors[0]
            const error = new Error(
              firstError
                ? `${firstError.errorType}: ${firstError.message}`
                : "AppSync subscription failed",
            )
            if (!connectionSettled) {
              connectionSettled = true
              reject(error)
              return
            }
            this.config.onError(error)
            return
          }
          case "data": {
            const parsed = JSON.parse(message.event) as {
              readonly documents?: readonly unknown[]
            }
            for (const execution of parsed.documents ?? []) {
              const normalized = normalizeExecution(execution)
              if (normalized) {
                this.config.onExecution(normalized)
              }
            }
            return
          }
          case "ka":
            return
          case "error": {
            const error = new Error(
              message.errors[0]?.message ?? "AppSync stream failed",
            )
            if (!connectionSettled) {
              connectionSettled = true
              reject(error)
              return
            }
            this.config.onError(error)
            return
          }
        }
      })

      this.socket.addEventListener("error", (event) => {
        const normalized = toError(event)
        if (!connectionSettled) {
          connectionSettled = true
          reject(normalized)
          return
        }
        this.config.onError(normalized)
      })

      this.socket.addEventListener("close", (event) => {
        const code = readCloseEventCode(event)
        if (!connectionSettled) {
          connectionSettled = true
          reject(
            new Error(
              `AppSync socket closed unexpectedly: code=${code ?? "unknown"}`,
            ),
          )
        }
        this.config.onClose()
      })
    })
  }

  disconnect(): void {
    this.socket?.close()
    this.socket = null
  }

  private subscribe(): void {
    this.subscriptionId = randomUUID()
    this.send({
      type: "subscribe",
      id: this.subscriptionId,
      channel: `/rxdb/collection/execution/user/${this.config.recipientId}`,
      authorization: {
        host: this.config.appSyncEventsHttpHost,
        authorization: this.config.accessToken,
      },
    })
  }

  private send(
    message: AppSyncConnectionInitMessage | AppSyncSubscribeMessage,
  ): void {
    if (this.socket?.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }
}

const createGraphqlWsExecutionEventSource = async (
  config: Extract<ExecutionEventSourceConfig, { kind: "GRAPHQL_WS" }>,
): Promise<ExecutionEventSource> => {
  const queue = new AsyncExecutionQueue()
  let isClosed = false

  const socket = new GraphqlExecutionSocket({
    wsEndpoint: config.wsEndpoint,
    accessToken: config.accessToken,
    onExecution: (execution) => {
      queue.push(execution)
    },
    onError: (error) => {
      if (isClosed) {
        return
      }
      queue.fail(error)
    },
    onClose: () => {
      if (isClosed) {
        return
      }
      queue.fail(new Error("GraphQL execution subscription disconnected"))
    },
    onComplete: () => {
      if (isClosed) {
        return
      }
      queue.finish()
    },
  })

  await socket.connect()

  return {
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    close: async () => {
      if (isClosed) {
        return
      }
      isClosed = true
      socket.disconnect()
      queue.finish()
    },
  }
}

const createAppSyncExecutionEventSource = async (
  config: Extract<ExecutionEventSourceConfig, { kind: "APPSYNC_EVENTS" }>,
  nowMillis: number,
  signal: AbortSignal,
): Promise<ExecutionEventSource> => {
  // Decode only for routing. AppSync still verifies the signature and current
  // authority. Never substitute config.userId/sub for canonical session facts.
  const invalidToken = () =>
    new Error(
      "CLI access token has invalid provider-user session claims. Run 'pfcli auth login'.",
    )
  const parts = config.accessToken.split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    throw invalidToken()
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    // JSON/schema diagnostics can contain credentials; expose only safe copy.
    throw invalidToken()
  }
  const claims = Schema.decodeUnknownOption(
    Schema.Struct({
      mode: Schema.Literal("access"),
      type: Schema.Literal("providerUser"),
      properties: ProviderUserSessionSchema,
      exp: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  )(raw)
  if (Option.isNone(claims)) throw invalidToken()
  if (nowMillis >= claims.value.exp * 1000) {
    throw new Error("CLI access token has expired. Run 'pfcli auth login'.")
  }
  const recipientId = await getRealtimeRecipientId(
    claims.value.properties,
    claims.value.exp,
  )
  if (!recipientId) throw invalidToken()
  const queue = new AsyncExecutionQueue()
  let isClosed = false

  const socket = new AppSyncExecutionSocket({
    realtimeUrl: config.realtimeUrl,
    appSyncEventsHttpHost: config.appSyncEventsHttpHost,
    accessToken: config.accessToken,
    recipientId,
    onExecution: (execution) => {
      queue.push(execution)
    },
    onError: (error) => {
      if (isClosed) {
        return
      }
      queue.fail(error)
    },
    onClose: () => {
      if (isClosed) {
        return
      }
      queue.fail(new Error("AppSync execution subscription disconnected"))
    },
  })

  const abort = () => {
    isClosed = true
    socket.disconnect()
    queue.finish()
  }
  signal.throwIfAborted()
  signal.addEventListener("abort", abort, { once: true })
  try {
    await socket.connect()
  } catch (error) {
    signal.removeEventListener("abort", abort)
    socket.disconnect()
    throw error
  }

  return {
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    close: async () => {
      if (isClosed) {
        return
      }
      isClosed = true
      signal.removeEventListener("abort", abort)
      socket.disconnect()
      queue.finish()
    },
  }
}

export const createExecutionEventSource = (
  config: ExecutionEventSourceConfig,
): Effect.Effect<ExecutionEventSource, CliError> =>
  Effect.flatMap(Clock.currentTimeMillis, (nowMillis) =>
    Effect.tryPromise({
      try: (signal) =>
        config.kind === "GRAPHQL_WS"
          ? createGraphqlWsExecutionEventSource(config)
          : createAppSyncExecutionEventSource(config, nowMillis, signal),
      catch: (cause) =>
        new CliError({
          message: `Failed to subscribe to execution updates: ${toError(cause).message}`,
          cause,
        }),
    }),
  )
