/**
 * AppSync Events WebSocket client using native browser WebSocket API
 * No external dependencies - just plain WebSocket + TypeScript
 */

/**
 * AppSync Events WebSocket protocol types
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
  isCurrent?: () => boolean
  expiresAt?: number
  onEvent: (event: string) => void
  onError?: (error: Error) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

/**
 * Get a cookie value by name from document.cookie
 */
export const getCookie = (name: string): string | undefined => {
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) {
    return parts.pop()?.split(";").shift()
  }
  return undefined
}

/**
 * Encode authorization object to Base64URL format for WebSocket subprotocol
 */
const encodeAuthHeader = (auth: Record<string, string>): string => {
  const header = btoa(JSON.stringify(auth))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `header-${header}`
}

/**
 * AppSync Events WebSocket client using native browser WebSocket API
 */
export class AppSyncEventsClient {
  private socket: WebSocket | null = null
  private subscriptionId: string | null = null
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 10
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimeout: ReturnType<typeof setTimeout> | null = null
  private isManualDisconnect = false
  private isAuthorizationError = false
  private accessToken: string | undefined

  constructor(private config: AppSyncEventsClientConfig) {}

  connect(): void {
    if (this.config.isCurrent && !this.config.isCurrent()) return
    if (
      this.config.expiresAt !== undefined &&
      Date.now() >= this.config.expiresAt * 1000
    )
      return
    if (this.socket?.readyState === WebSocket.OPEN) {
      console.warn("Already connected to AppSync Events")
      return
    }

    this.isManualDisconnect = false
    this.isAuthorizationError = false

    // Read access token from cookie (now non-HttpOnly so JavaScript can access it)
    const accessToken = getCookie("access_token")
    // A client instance must never adopt credentials from another session.
    if (this.accessToken && this.accessToken !== accessToken) return
    if (!accessToken) {
      console.error(
        "No access_token cookie found - cannot authorize WebSocket connection",
      )
      this.config.onError?.(new Error("No access token available"))
      return
    }
    this.accessToken = accessToken

    // Build authorization object using provided HTTP host and access token
    const authorization = {
      // We must provide a host for authorization (or possibly anything) to work,
      // else you get "400: Missing host header"
      host: this.config.httpHost,
      // With lambda authorization we need an "authorization" header with the JWT,
      // else we get: "400: Required headers are missing"
      authorization: accessToken,
    }

    // Debug logging
    console.log("AppSync Events config:", {
      realtimeUrl: this.config.realtimeUrl,
      httpHost: this.config.httpHost,
      channel: this.config.channel,
    })

    // Create WebSocket with AppSync Events subprotocol
    const authProtocol = encodeAuthHeader(authorization)
    this.socket = new WebSocket(this.config.realtimeUrl, [
      "aws-appsync-event-ws",
      authProtocol,
    ])
    const socket = this.socket
    const isCurrent = () =>
      this.socket === socket &&
      !this.isManualDisconnect &&
      (!this.config.isCurrent || this.config.isCurrent()) &&
      (this.config.expiresAt === undefined ||
        Date.now() < this.config.expiresAt * 1000) &&
      getCookie("access_token") === accessToken

    this.socket.onopen = () => {
      if (!isCurrent()) return
      console.log("AppSync Events WebSocket connected")
      this.reconnectAttempts = 0

      // Send connection_init
      this.send({ type: "connection_init" })
    }

    this.socket.onmessage = (event) => {
      if (!isCurrent()) return
      console.debug("AppSync Events received message:", event.data)
      const message = JSON.parse(event.data) as ServerMessage

      switch (message.type) {
        case "connection_ack":
          console.log("AppSync Events connection acknowledged")
          this.startKeepAliveMonitor(message.connectionTimeoutMs)
          this.subscribe()
          this.config.onConnect?.()
          break

        case "connection_error": {
          console.error("AppSync Events connection error:", message.errors)
          const errorMsg = message.errors[0]

          // Authorization errors (401/403) should not retry - token is invalid
          if (errorMsg?.errorCode === 401 || errorMsg?.errorCode === 403) {
            this.isAuthorizationError = true
          }

          if (errorMsg) {
            const errorDetail = `${errorMsg.errorType} (${errorMsg.errorCode}): ${errorMsg.message || "No message"}`
            this.config.onError?.(new Error(errorDetail))
          } else {
            this.config.onError?.(new Error("Connection error with no details"))
          }
          this.socket?.close()
          break
        }

        case "subscribe_success":
          console.log("Subscribed to channel:", this.config.channel)
          break

        case "subscribe_error": {
          console.error("AppSync Events subscription error:", message.errors)
          const errMsg = message.errors[0]
          // Treat subscription authorization failures as auth errors - don't retry
          if (
            errMsg?.errorType === "UnauthorizedException" ||
            errMsg?.errorType === "Forbidden"
          ) {
            this.isAuthorizationError = true
          }
          this.config.onError?.(
            new Error(
              errMsg
                ? `${errMsg.errorType}: ${errMsg.message}`
                : "Subscription error with no details",
            ),
          )
          break
        }

        case "data":
          if (message.id !== this.subscriptionId) return
          // Reset keep-alive timeout on data receipt
          this.resetKeepAliveMonitor()
          this.config.onEvent(message.event)
          break

        case "ka":
          // Keep-alive message - reset timeout
          this.resetKeepAliveMonitor()
          break

        case "error":
          console.error("AppSync Events error:", message.errors)
          this.config.onError?.(
            new Error(message.errors[0]?.message || "Unknown error"),
          )
          break

        default:
          console.warn("Unknown message type:", message)
      }
    }

    this.socket.onerror = (error) => {
      if (!isCurrent()) return
      console.error("AppSync Events WebSocket error:", error)
      this.config.onError?.(new Error("WebSocket error"))
    }

    this.socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.subscriptionId = null
      console.log("AppSync Events WebSocket closed")
      this.cleanup()
      this.config.onDisconnect?.()

      // Attempt reconnection unless manually disconnected or auth failed
      if (!this.isManualDisconnect && !this.isAuthorizationError) {
        this.scheduleReconnect()
      }
    }
  }

  /**
   * Subscribe via the HTTP endpoint.
   */
  private subscribe(): void {
    const authorization = {
      host: this.config.httpHost,
      authorization: this.accessToken || "",
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

  private startKeepAliveMonitor(timeoutMs: number): void {
    // Set timeout to slightly more than server's keep-alive interval
    // Server sends ka every 60 seconds, timeout is typically 5 minutes
    this.keepAliveTimeout = setTimeout(() => {
      console.warn("Keep-alive timeout - reconnecting")
      this.socket?.close()
    }, timeoutMs)
  }

  private resetKeepAliveMonitor(): void {
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout)
      this.keepAliveTimeout = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached")
      this.config.onError?.(new Error("Max reconnection attempts reached"))
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 30s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000)
    this.reconnectAttempts++

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    )
    this.reconnectTimeout = setTimeout(() => {
      this.connect()
    }, delay)
  }

  disconnect(): void {
    this.isManualDisconnect = true
    this.cleanup()
    this.socket?.close()
    this.socket = null
    this.subscriptionId = null
  }

  /**
   * Reconnect to AppSync Events with fresh credentials.
   * Used when token is refreshed to ensure WebSocket uses new auth.
   */
  reconnect(): void {
    console.log("Reconnecting to AppSync Events with fresh credentials...")
    this.disconnect()
    this.connect() // connect() reads fresh token from cookie
  }

  private cleanup(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout)
      this.keepAliveTimeout = null
    }
  }
}
