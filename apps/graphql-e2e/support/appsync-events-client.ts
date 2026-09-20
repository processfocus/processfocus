import WebSocket from "ws"

/**
 * AppSync Events WebSocket client for Node.js (e2e tests)
 * Adapted from apps/frontend/lib/appsync-events/client.ts
 */

type ConnectionInitMessage = { type: "connection_init" }
type ConnectionAckMessage = {
  type: "connection_ack"
  connectionTimeoutMs: number
}
type ConnectionErrorMessage = {
  type: "connection_error"
  errors: Array<{ errorType: string; errorCode: number; message?: string }>
}
type SubscribeMessage = {
  type: "subscribe"
  id: string
  channel: string
  authorization: Record<string, string>
}
type SubscribeSuccessMessage = { type: "subscribe_success"; id: string }
type SubscribeErrorMessage = {
  type: "subscribe_error"
  id: string
  errors: Array<{ errorType: string; message: string }>
}
type DataMessage = { type: "data"; id: string; event: string }
type KeepAliveMessage = { type: "ka" }
type ErrorMessage = {
  type: "error"
  id?: string
  errors: Array<{ message: string }>
}

type ServerMessage =
  | ConnectionAckMessage
  | ConnectionErrorMessage
  | SubscribeSuccessMessage
  | SubscribeErrorMessage
  | DataMessage
  | KeepAliveMessage
  | ErrorMessage

interface AppSyncEventsClientConfig {
  realtimeUrl: string
  httpHost: string
  channel: string
  accessToken: string
  onEvent: (event: unknown) => void
  onError?: (error: Error) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

/**
 * Encode authorization object to Base64URL format for WebSocket subprotocol
 */
const encodeAuthHeader = (auth: Record<string, string>): string => {
  const header = Buffer.from(JSON.stringify(auth))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `header-${header}`
}

/**
 * AppSync Events WebSocket client for Node.js
 */
export class AppSyncEventsClient {
  private socket: WebSocket | null = null
  private subscriptionId: string | null = null

  constructor(private config: AppSyncEventsClientConfig) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      const authorization = {
        host: this.config.httpHost,
        authorization: this.config.accessToken,
      }

      const authProtocol = encodeAuthHeader(authorization)
      this.socket = new WebSocket(this.config.realtimeUrl, [
        "aws-appsync-event-ws",
        authProtocol,
      ])

      let connectionResolved = false

      this.socket.on("open", () => {
        this.send({ type: "connection_init" })
      })

      this.socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as ServerMessage

        switch (message.type) {
          case "connection_ack":
            this.subscribe()
            break

          case "connection_error": {
            const errorMsg = message.errors[0]
            const error = new Error(
              errorMsg
                ? `${errorMsg.errorType} (${errorMsg.errorCode}): ${errorMsg.message || "No message"}`
                : "Connection error with no details",
            )
            if (!connectionResolved) {
              connectionResolved = true
              reject(error)
            }
            this.config.onError?.(error)
            this.socket?.close()
            break
          }

          case "subscribe_success":
            if (!connectionResolved) {
              connectionResolved = true
              this.config.onConnect?.()
              resolve()
            }
            break

          case "subscribe_error": {
            const errMsg = message.errors[0]
            const error = new Error(
              errMsg
                ? `${errMsg.errorType}: ${errMsg.message}`
                : "Subscription error with no details",
            )
            if (!connectionResolved) {
              connectionResolved = true
              reject(error)
            }
            this.config.onError?.(error)
            break
          }

          case "data":
            // Parse the event JSON string
            try {
              const eventData = JSON.parse(message.event)
              this.config.onEvent(eventData)
            } catch {
              this.config.onEvent(message.event)
            }
            break

          case "ka":
            // Keep-alive - ignore
            break

          case "error": {
            const error = new Error(
              message.errors[0]?.message || "Unknown error",
            )
            if (!connectionResolved) {
              connectionResolved = true
              reject(error)
            }
            this.config.onError?.(error)
            break
          }
        }
      })

      this.socket.on("error", (error) => {
        if (!connectionResolved) {
          connectionResolved = true
          reject(error)
        }
        this.config.onError?.(error)
      })

      this.socket.on("close", (code) => {
        if (!connectionResolved) {
          connectionResolved = true
          reject(new Error(`WebSocket closed unexpectedly: code=${code}`))
        }
        this.config.onDisconnect?.()
      })
    })
  }

  private subscribe(): void {
    const authorization = {
      host: this.config.httpHost,
      authorization: this.config.accessToken,
    }

    this.subscriptionId = crypto.randomUUID()
    this.send({
      type: "subscribe",
      id: this.subscriptionId,
      channel: this.config.channel,
      authorization,
    })
  }

  private send(message: ConnectionInitMessage | SubscribeMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  disconnect(): void {
    this.socket?.close()
    this.socket = null
  }
}
