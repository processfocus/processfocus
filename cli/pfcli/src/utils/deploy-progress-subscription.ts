import { randomUUID } from "node:crypto"
import { Data, Effect, Option, Schema } from "effect"
import { CliError } from "../errors"
import type {
  DeployProgressEvent,
  DeployProgressEventSource,
  DeployProgressEventSourceConfig,
  DeployProgressStatus,
} from "./deploy-progress-subscription.types"

const DEPLOY_PROGRESS_CONNECT_TIMEOUT_MS = 30 * 1000
const DEPLOY_PROGRESS_MAX_RECONNECT_ATTEMPTS = 3
const DEPLOY_PROGRESS_RECONNECT_BASE_DELAY_MS = 500
export const DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE =
  "Lost the deploy progress connection"

export class DeployProgressTransportError extends Data.TaggedError(
  "DeployProgressTransportError",
)<{ readonly message: string; readonly cause?: unknown }> {}

const DEPLOY_PROGRESS_STATUS_VALUES = [
  "progress",
  "completed",
  "failed",
] as const

const DEPLOY_PROGRESS_STATUS_SET = new Set<string>(
  DEPLOY_PROGRESS_STATUS_VALUES,
)

interface AsyncQueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void
  readonly reject: (reason?: unknown) => void
}

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

class AsyncDeployProgressQueue implements AsyncIterable<DeployProgressEvent> {
  private readonly items: DeployProgressEvent[] = []
  private readonly waiters: AsyncQueueWaiter<DeployProgressEvent>[] = []
  private closed = false
  private failure: Error | null = null

  push(item: DeployProgressEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<DeployProgressEvent> {
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

        return new Promise<IteratorResult<DeployProgressEvent>>(
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

interface CloseEventDetails {
  readonly code: number | undefined
  readonly reason: string | undefined
}

const readCloseEventDetails = (event: unknown): CloseEventDetails => {
  if (typeof event === "object" && event !== null) {
    const code =
      "code" in event && typeof event["code"] === "number"
        ? event["code"]
        : undefined
    const reason =
      "reason" in event && typeof event["reason"] === "string"
        ? event["reason"]
        : undefined
    return { code, reason }
  }

  return { code: undefined, reason: undefined }
}

const progressCloseError = ({ code, reason }: CloseEventDetails): Error => {
  const message = `AppSync socket closed unexpectedly: code=${code ?? "unknown"}${reason ? ` reason=${reason}` : ""}`
  // Normal disconnects and transient server/transport failures can reconnect.
  // Protocol, policy and application-specific rejection codes remain fatal.
  return code === undefined ||
    [1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014].includes(code)
    ? new DeployProgressTransportError({ message })
    : new Error(message)
}

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }

  if (Array.isArray(error)) {
    return new Error(error.map((entry) => String(entry)).join(", "))
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

const encodeAppSyncAuthHeader = (auth: Record<string, string>): string => {
  const header = Buffer.from(JSON.stringify(auth)).toString("base64url")
  return `header-${header}`
}

const isDeployProgressStatus = (
  value: unknown,
): value is DeployProgressStatus =>
  typeof value === "string" && DEPLOY_PROGRESS_STATUS_SET.has(value)

const normalizeDeployProgressEvent = (
  value: unknown,
): DeployProgressEvent | null => {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const record = value as Record<string, unknown>
  if (
    record["version"] !== 1 ||
    typeof record["executionId"] !== "string" ||
    typeof record["phase"] !== "string" ||
    !isDeployProgressStatus(record["status"]) ||
    typeof record["message"] !== "string" ||
    typeof record["timestamp"] !== "string"
  ) {
    return null
  }

  return {
    version: 1,
    executionId: record["executionId"],
    phase: record["phase"],
    status: record["status"],
    message: record["message"],
    timestamp: record["timestamp"],
  }
}

class AppSyncDeployProgressSocket {
  private socket: WebSocket | null = null
  private subscriptionId: string | null = null
  private accessToken = ""
  private channel = ""
  private disconnected = false

  constructor(
    private readonly config: {
      readonly realtimeUrl: string
      readonly appSyncEventsHttpHost: string
      readonly accessToken: string
      readonly acquireAccessToken?: () => Promise<string>
      readonly channel: string
      readonly bindToTokenExpiry?: boolean
      readonly onEvent: (event: DeployProgressEvent) => void
      readonly onError: (error: Error) => void
      readonly onTransportError: (error: Error) => void
      readonly onClose: (code?: number, reason?: string) => void
    },
  ) {}

  async connect(): Promise<void> {
    this.accessToken = this.config.acquireAccessToken
      ? await this.config.acquireAccessToken()
      : this.config.accessToken
    if (this.disconnected)
      throw new Error("Deploy progress connection cancelled")
    this.channel = this.config.channel
    const routingClaims = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          properties: Schema.optional(
            Schema.Struct({ sso: Schema.optional(Schema.Unknown) }),
          ),
        }),
      ),
    )(
      Buffer.from(this.accessToken.split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    )
    const sso =
      Option.isSome(routingClaims) &&
      routingClaims.value.properties?.sso !== undefined
    if (this.config.bindToTokenExpiry || sso) {
      // Routing only; the server verifies the signature, owner and deadline.
      try {
        const payload = this.accessToken.split(".")[1]
        if (!payload) throw new Error("Missing payload")
        const claims = Schema.decodeUnknownSync(
          Schema.Struct({
            exp: Schema.Number.pipe(
              Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
            ),
          }),
        )(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
        this.channel = `${this.config.channel}/${claims.exp}`
      } catch {
        throw new Error(
          "Invalid token expiry for deployment progress; authenticate again",
        )
      }
    }
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        reject(new Error("WebSocket is not available in this runtime."))
        return
      }

      const authorization = {
        host: this.config.appSyncEventsHttpHost,
        authorization: this.accessToken,
      }

      const authProtocol = encodeAppSyncAuthHeader(authorization)
      this.socket = new WebSocket(this.config.realtimeUrl, [
        "aws-appsync-event-ws",
        authProtocol,
      ])

      let connectionSettled = false
      const connectTimeout = setTimeout(() => {
        const error = new DeployProgressTransportError({
          message: `Timed out waiting for AppSync deploy progress connection after ${DEPLOY_PROGRESS_CONNECT_TIMEOUT_MS / 1000}s`,
        })
        if (!connectionSettled) {
          connectionSettled = true
          reject(error)
          this.socket?.close()
        }
      }, DEPLOY_PROGRESS_CONNECT_TIMEOUT_MS)

      const resolveConnection = () => {
        if (!connectionSettled) {
          connectionSettled = true
          clearTimeout(connectTimeout)
          resolve()
          return true
        }

        return false
      }

      const rejectConnection = (error: Error) => {
        if (!connectionSettled) {
          connectionSettled = true
          clearTimeout(connectTimeout)
          reject(error)
          return true
        }

        return false
      }

      this.socket.addEventListener("open", () => {
        this.send({ type: "connection_init" })
      })

      this.socket.addEventListener("message", (event) => {
        let message: AppSyncServerMessage
        try {
          message = JSON.parse(
            readWebSocketMessage(event.data),
          ) as AppSyncServerMessage
        } catch (parseError) {
          const error = toError(parseError)
          if (!connectionSettled) {
            connectionSettled = true
            clearTimeout(connectTimeout)
            reject(error)
            return
          }
          this.config.onError(error)
          return
        }

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
            if (rejectConnection(error)) {
              return
            }
            this.config.onError(error)
            return
          }
          case "subscribe_success":
            if (resolveConnection()) {
              return
            }
            return
          case "subscribe_error": {
            const firstError = message.errors[0]
            const error = new Error(
              firstError
                ? `${firstError.errorType}: ${firstError.message}`
                : "AppSync subscription failed",
            )
            if (rejectConnection(error)) {
              return
            }
            this.config.onError(error)
            return
          }
          case "data": {
            try {
              const normalized = normalizeDeployProgressEvent(
                JSON.parse(message.event),
              )
              if (normalized) {
                this.config.onEvent(normalized)
              }
            } catch (error) {
              this.config.onError(toError(error))
            }
            return
          }
          case "ka":
            return
          case "error": {
            const error = new Error(
              message.errors[0]?.message ?? "AppSync stream failed",
            )
            if (rejectConnection(error)) {
              return
            }
            this.config.onError(error)
            return
          }
        }
      })

      this.socket.addEventListener("error", (event) => {
        const normalized = toError(event)
        if (
          rejectConnection(
            new DeployProgressTransportError({
              message: "Deployment progress connection failed",
              cause: normalized,
            }),
          )
        ) {
          return
        }
        this.config.onTransportError(normalized)
      })

      this.socket.addEventListener("close", (event) => {
        const { code, reason } = readCloseEventDetails(event)
        const error = progressCloseError({ code, reason })
        if (rejectConnection(error)) return
        if (error instanceof DeployProgressTransportError)
          this.config.onClose(code, reason)
        else this.config.onError(error)
      })
    })
  }

  disconnect(): void {
    this.disconnected = true
    this.socket?.close()
    this.socket = null
  }

  private subscribe(): void {
    this.subscriptionId = randomUUID()
    this.send({
      type: "subscribe",
      id: this.subscriptionId,
      channel: this.channel,
      authorization: {
        host: this.config.appSyncEventsHttpHost,
        authorization: this.accessToken,
      },
    })
  }

  private send(
    message: AppSyncConnectionInitMessage | AppSyncSubscribeMessage,
  ): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }
}

const createAppSyncDeployProgressEventSource = async (
  config: DeployProgressEventSourceConfig,
  signal: AbortSignal,
): Promise<DeployProgressEventSource> => {
  const queue = new AsyncDeployProgressQueue()
  let isClosed = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let socket: Pick<AppSyncDeployProgressSocket, "connect" | "disconnect">

  const reconnect = (detail: string, cause?: unknown) => {
    if (isClosed) return
    if (reconnectAttempts >= DEPLOY_PROGRESS_MAX_RECONNECT_ATTEMPTS) {
      queue.fail(
        new Error(
          `${DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE}${detail}. Reconnection attempts exhausted.`,
          { cause },
        ),
      )
      return
    }
    const delayMs =
      DEPLOY_PROGRESS_RECONNECT_BASE_DELAY_MS *
      2 ** reconnectAttempts *
      (1 + Math.random())
    reconnectAttempts++
    process.stderr.write(
      `\nDeploy progress connection interrupted${detail}; reconnecting (attempt ${reconnectAttempts}/${DEPLOY_PROGRESS_MAX_RECONNECT_ATTEMPTS}). Deployment continues.\n`,
    )
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (isClosed) return
      socket = createSocket()
      void socket.connect().then(
        () => {
          if (!isClosed) {
            reconnectAttempts = 0
            process.stderr.write("\nDeploy progress connection restored.\n")
          }
        },
        (cause: unknown) => {
          socket.disconnect()
          if (!(cause instanceof DeployProgressTransportError)) {
            queue.fail(toError(cause))
            return
          }
          reconnect(" (reconnection failed)", cause)
        },
      )
    }, delayMs)
  }

  const createSocket = (): Pick<
    AppSyncDeployProgressSocket,
    "connect" | "disconnect"
  > => {
    // A retired socket may still dispatch its close event after its replacement
    // has connected. Only the current socket may schedule a reconnect.
    let retired = false
    const retire = () => {
      retired = true
      connection.disconnect()
    }
    const connection = new AppSyncDeployProgressSocket({
      realtimeUrl: config.realtimeUrl,
      appSyncEventsHttpHost: config.appSyncEventsHttpHost,
      accessToken: config.accessToken,
      ...(config.acquireAccessToken
        ? { acquireAccessToken: config.acquireAccessToken }
        : {}),
      channel: config.channel,
      ...(config.bindToTokenExpiry ? { bindToTokenExpiry: true } : {}),
      onEvent: (event) => {
        queue.push(event)
      },
      onError: (error) => {
        if (isClosed || retired) {
          return
        }
        queue.fail(error)
        retire()
      },
      onTransportError: (error) => {
        if (isClosed || retired) return
        retire()
        reconnect(" (transport error)", error)
      },
      onClose: (code, reason) => {
        if (isClosed || retired) {
          return
        }
        retire()
        const detail =
          code !== undefined
            ? ` (close code ${code}${reason ? `: ${reason}` : ""})`
            : ""
        reconnect(detail)
      },
    })
    return {
      connect: () => connection.connect(),
      disconnect: retire,
    }
  }
  socket = createSocket()

  const abort = () => {
    isClosed = true
    clearTimeout(reconnectTimer)
    socket.disconnect()
    queue.finish()
  }
  signal.throwIfAborted()
  signal.addEventListener("abort", abort, { once: true })
  try {
    await socket.connect()
  } catch (error) {
    isClosed = true
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
      clearTimeout(reconnectTimer)
      signal.removeEventListener("abort", abort)
      socket.disconnect()
      queue.finish()
    },
  }
}

export const createDeployProgressEventSource = (
  config: DeployProgressEventSourceConfig,
): Effect.Effect<DeployProgressEventSource, CliError> =>
  Effect.tryPromise({
    try: (signal) => createAppSyncDeployProgressEventSource(config, signal),
    catch: (cause) =>
      new CliError({
        message: `Failed to subscribe to deployment progress: ${toError(cause).message}`,
        cause,
      }),
  })
