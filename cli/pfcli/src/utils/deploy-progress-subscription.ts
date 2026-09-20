import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { CliError } from "../errors"
import type {
  DeployProgressEvent,
  DeployProgressEventSource,
  DeployProgressEventSourceConfig,
  DeployProgressStatus,
} from "./deploy-progress-subscription.types"

const DEPLOY_PROGRESS_CONNECT_TIMEOUT_MS = 30 * 1000
export const DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE =
  "Lost the deploy progress connection"

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

  constructor(
    private readonly config: {
      readonly realtimeUrl: string
      readonly appSyncEventsHttpHost: string
      readonly accessToken: string
      readonly channel: string
      readonly onEvent: (event: DeployProgressEvent) => void
      readonly onError: (error: Error) => void
      readonly onClose: (code?: number, reason?: string) => void
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
      const connectTimeout = setTimeout(() => {
        const error = new Error(
          `Timed out waiting for AppSync deploy progress connection after ${DEPLOY_PROGRESS_CONNECT_TIMEOUT_MS / 1000}s`,
        )
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
        if (rejectConnection(normalized)) {
          return
        }
        this.config.onError(normalized)
      })

      this.socket.addEventListener("close", (event) => {
        const { code, reason } = readCloseEventDetails(event)
        if (
          rejectConnection(
            new Error(
              `AppSync socket closed unexpectedly: code=${code ?? "unknown"}${reason ? ` reason=${reason}` : ""}`,
            ),
          )
        ) {
          return
        }
        this.config.onClose(code, reason)
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
      channel: this.config.channel,
      authorization: {
        host: this.config.appSyncEventsHttpHost,
        authorization: this.config.accessToken,
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
): Promise<DeployProgressEventSource> => {
  const queue = new AsyncDeployProgressQueue()
  let isClosed = false

  const socket = new AppSyncDeployProgressSocket({
    realtimeUrl: config.realtimeUrl,
    appSyncEventsHttpHost: config.appSyncEventsHttpHost,
    accessToken: config.accessToken,
    channel: config.channel,
    onEvent: (event) => {
      queue.push(event)
    },
    onError: (error) => {
      if (isClosed) {
        return
      }
      queue.fail(error)
    },
    onClose: (code, reason) => {
      if (isClosed) {
        return
      }
      const detail =
        code !== undefined
          ? ` (close code ${code}${reason ? `: ${reason}` : ""})`
          : ""
      process.stderr.write(`\nDeploy progress WebSocket closed${detail}\n`)
      queue.fail(
        new Error(
          `${DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE}${detail}. The deployment may still be running; check the Backend or deployment logs.`,
        ),
      )
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

export const createDeployProgressEventSource = (
  config: DeployProgressEventSourceConfig,
): Effect.Effect<DeployProgressEventSource, CliError> =>
  Effect.tryPromise({
    try: () => createAppSyncDeployProgressEventSource(config),
    catch: (cause) =>
      new CliError({
        message: `Failed to subscribe to deployment progress: ${toError(cause).message}`,
        cause,
      }),
  })
