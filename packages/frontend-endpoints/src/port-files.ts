/**
 * Node.js-only utilities for reading port files.
 * DO NOT import this file from browser/client code - it uses node:fs.
 *
 * For local development, the graphql and auth servers write their ports
 * to .graphql-port.json and .auth-port.json files. This module reads those files.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  getAuthUrl,
  getBaseUrl,
  getFrontendBaseUrl,
  getGraphqlEndpoint,
  getWsEndpoint,
} from "./endpoint"

/**
 * Check if BASE_URL points to localhost (with or without port).
 * @internal Exported for testing
 */
export const isLocalhostUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  } catch {
    return false
  }
}

/**
 * Check if we should read from port files to get the actual port.
 * Returns true when:
 * - BASE_URL is not set (local development without explicit config)
 * - BASE_URL points to localhost (with or without port)
 *
 * Returns false when GRAPHQL_ENDPOINT is set, as that indicates
 * an explicit endpoint override (e.g., E2E tests with dynamic ports).
 *
 * @internal Exported for testing
 */
export const shouldUsePortFiles = (): boolean => {
  // Explicit endpoint override takes precedence
  if (process.env["GRAPHQL_ENDPOINT"]) {
    return false
  }

  const baseUrl = getBaseUrl()
  return baseUrl === undefined || isLocalhostUrl(baseUrl)
}

const DEFAULT_GRAPHQL_PORT = 4000
const DEFAULT_AUTH_PORT = 4020
const DEFAULT_FRONTEND_PORT = 3000
const GRAPHQL_PORT_FILE = ".graphql-port.json"
const AUTH_PORT_FILE = ".auth-port.json"
const FRONTEND_PORT_FILE = ".frontend-port.json"

/**
 * Gets the runtime state directory. Installed runtimes set PF_RUNTIME_ROOT;
 * direct CLI usage writes port files in the current working directory.
 */
const getRuntimeRoot = (): string =>
  process.env["PF_RUNTIME_ROOT"] ??
  process.env["NX_WORKSPACE_ROOT"] ??
  process.cwd()

/**
 * Port file JSON structure.
 */
interface PortFileContent {
  readonly port: number
}

/**
 * Type guard to validate port file content.
 */
const isValidPortFileContent = (value: unknown): value is PortFileContent => {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return "port" in record && typeof record["port"] === "number"
}

/**
 * Reads a port from a JSON file in the runtime state directory.
 * Returns undefined if file doesn't exist or contains invalid content.
 */
const readPortFromFile = (filename: string): number | undefined => {
  try {
    const filePath = join(getRuntimeRoot(), filename)
    const content = readFileSync(filePath, "utf-8")
    const parsed: unknown = JSON.parse(content)
    return isValidPortFileContent(parsed) ? parsed.port : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the GraphQL port from .graphql-port.json in the runtime state directory.
 * Returns the port number, or DEFAULT_GRAPHQL_PORT if file doesn't exist.
 */
export const readGraphqlPort = (): number =>
  readPortFromFile(GRAPHQL_PORT_FILE) ?? DEFAULT_GRAPHQL_PORT

/**
 * Reads the auth port from .auth-port in the runtime state directory.
 * Returns the port number, or DEFAULT_AUTH_PORT if file doesn't exist.
 */
export const readAuthPort = (): number =>
  readPortFromFile(AUTH_PORT_FILE) ?? DEFAULT_AUTH_PORT

/**
 * Reads the frontend port from .frontend-port.json in the runtime state directory.
 * Returns the port number, or DEFAULT_FRONTEND_PORT if file doesn't exist.
 */
export const readFrontendPort = (): number =>
  readPortFromFile(FRONTEND_PORT_FILE) ?? DEFAULT_FRONTEND_PORT

/**
 * Gets the GraphQL endpoint URL by reading from .graphql-port.json file.
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getGraphqlEndpointFromPortFile = (): string =>
  `http://localhost:${readGraphqlPort()}/graphql`

/**
 * Gets the WebSocket endpoint URL by reading from .graphql-port.json file.
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getWsEndpointFromPortFile = (): string =>
  `ws://localhost:${readGraphqlPort()}/graphql`

/**
 * Gets the auth server URL by reading from .auth-port file.
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getAuthUrlFromPortFile = (): string =>
  `http://localhost:${readAuthPort()}`

/**
 * Gets the frontend base URL by reading from .frontend-port.json file.
 * For use in Node.js environments (local runtime invalidation).
 */
export const getFrontendBaseUrlFromPortFile = (): string =>
  `http://localhost:${readFrontendPort()}`

/**
 * Gets the effective GraphQL endpoint.
 * When BASE_URL=http://localhost, reads port from .graphql-port.json file.
 * Otherwise uses standard endpoint resolution.
 *
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getEffectiveGraphqlEndpoint = (): string => {
  if (shouldUsePortFiles()) {
    return getGraphqlEndpointFromPortFile()
  }
  return getGraphqlEndpoint()
}

/**
 * Gets the effective WebSocket endpoint.
 * When BASE_URL=http://localhost, reads port from .graphql-port.json file.
 * Otherwise uses standard endpoint resolution.
 *
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getEffectiveWsEndpoint = (): string => {
  if (shouldUsePortFiles()) {
    return getWsEndpointFromPortFile()
  }
  return getWsEndpoint()
}

/**
 * Gets the effective auth server URL.
 * When BASE_URL=http://localhost, reads port from .auth-port file.
 * Otherwise uses standard endpoint resolution.
 *
 * For use in Node.js environments (e2e tests, local runtime).
 */
export const getEffectiveAuthUrl = (): string => {
  if (shouldUsePortFiles()) {
    return getAuthUrlFromPortFile()
  }
  return getAuthUrl()
}

/**
 * Gets the effective frontend base URL.
 * When FRONTEND_BASE_URL or BASE_URL points to localhost (or both are unset),
 * reads the port from .frontend-port.json. Otherwise returns the configured
 * frontend URL.
 *
 * For use in Node.js environments (local runtime cache invalidation).
 */
export const getEffectiveFrontendBaseUrl = (): string => {
  const frontendBaseUrl = getFrontendBaseUrl()

  if (frontendBaseUrl) {
    if (isLocalhostUrl(frontendBaseUrl)) {
      return getFrontendBaseUrlFromPortFile()
    }

    return frontendBaseUrl
  }

  if (shouldUsePortFiles()) {
    return getFrontendBaseUrlFromPortFile()
  }

  // shouldUsePortFiles() also returns false when GRAPHQL_ENDPOINT is set,
  // even if BASE_URL is unset, so keep the standard local frontend fallback.
  const baseUrl = getBaseUrl()
  return baseUrl ?? "http://localhost:3000"
}
