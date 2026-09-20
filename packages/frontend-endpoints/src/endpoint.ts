const DEFAULT_GRAPHQL_PORT = 4000
const DEFAULT_AUTH_PORT = 4020

/**
 * Gets the base URL if set via BASE_URL env var.
 * Used to point all endpoints to a deployed AWS runtime.
 *
 * Note: When BASE_URL is "http://localhost" (without port), this still returns
 * it. For E2E tests that need port file reading, use the functions from
 * "./port-files" instead (Node.js only).
 */
export const getBaseUrl = (): string | undefined => process.env["BASE_URL"]

/**
 * Gets the frontend base URL if set via FRONTEND_BASE_URL env var.
 * Falls back to BASE_URL when a separate frontend URL is not needed.
 */
export const getFrontendBaseUrl = (): string | undefined =>
  process.env["FRONTEND_BASE_URL"] ?? getBaseUrl()

// GraphQL endpoint - configurable via environment variable
export const getGraphqlEndpoint = (): string => {
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    return `${baseUrl}/graphql`
  }

  if (process.env["GRAPHQL_ENDPOINT"]) {
    return process.env["GRAPHQL_ENDPOINT"]
  }

  return `http://localhost:${DEFAULT_GRAPHQL_PORT}/graphql`
}

export const getWsEndpoint = (): string => {
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    return `${baseUrl.replace("http", "ws")}/graphql`
  }

  if (process.env["NEXT_PUBLIC_WS_ENDPOINT"]) {
    return process.env["NEXT_PUBLIC_WS_ENDPOINT"]
  }
  return getGraphqlEndpoint().replace("http", "ws")
}

/**
 * Gets the GraphQL server base URL (without /graphql path).
 * Used for non-GraphQL endpoints like /cedar/policies.
 */
export const getGraphqlServerBaseUrl = (): string => {
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    return baseUrl
  }

  if (process.env["GRAPHQL_ENDPOINT"]) {
    // Remove /graphql suffix if present
    return process.env["GRAPHQL_ENDPOINT"].replace(/\/graphql$/, "")
  }

  return `http://localhost:${DEFAULT_GRAPHQL_PORT}`
}

/**
 * Gets the auth server URL.
 * Used by frontend-e2e for authentication.
 */
export const getAuthUrl = (): string => {
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    return baseUrl
  }
  if (process.env["AUTH_URL"]) {
    return process.env["AUTH_URL"]
  }
  return `http://localhost:${DEFAULT_AUTH_PORT}`
}

/**
 * Check if AppSync Events should be used for subscriptions.
 * Returns true when APPSYNC_EVENTS_HTTP_HOST is configured.
 */
export const usesAppSyncEvents = (): boolean => {
  return !!process.env["APPSYNC_EVENTS_HTTP_HOST"]
}

/**
 * Gets the AppSync Events HTTP host for authorization.
 * This is the actual AppSync API domain (not CloudFront) used in auth headers.
 *
 * Required for AppSync Events - the host in authorization must match AppSync's domain.
 * Set via APPSYNC_EVENTS_HTTP_HOST env var when deploying to AWS.
 *
 * Returns undefined if not in AWS mode or not configured.
 */
export const getAppSyncEventsHttpHost = (): string | undefined => {
  // Explicit env var takes precedence
  if (process.env["APPSYNC_EVENTS_HTTP_HOST"]) {
    return process.env["APPSYNC_EVENTS_HTTP_HOST"]
  }
  return undefined
}

/**
 * Gets the AppSync Events realtime WebSocket URL.
 * This is the CloudFront-proxied endpoint for WebSocket connections.
 *
 * Resolution order:
 * 1. NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL env var (for local dev with remote AppSync)
 * 2. Derived from BASE_URL if running against AWS (CloudFront)
 * 3. Browser's window.location.host if browserHost is provided
 *
 * @param browserHost - Optional browser host for client-side fallback (e.g., window.location.host)
 * @returns The realtime URL, or undefined if not in AWS mode and no fallback
 */
export const getAppSyncEventsRealtimeUrl = (
  browserHost?: string,
): string | undefined => {
  // Explicit env var takes precedence (for local dev with remote AppSync)
  if (process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"]) {
    return process.env["NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_URL"]
  }

  // Derive from BASE_URL if using AppSync Events
  const baseUrl = getBaseUrl()
  if (baseUrl && usesAppSyncEvents()) {
    return `${baseUrl.replace("https://", "wss://").replace("http://", "ws://")}/event/realtime`
  }

  // Browser fallback: use provided host (for client-side code)
  if (browserHost) {
    return `wss://${browserHost}/event/realtime`
  }

  return undefined
}
