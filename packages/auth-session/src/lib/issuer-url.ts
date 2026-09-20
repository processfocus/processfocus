import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripTrailingSlash } from "./url"

export const DEFAULT_AUTH_PORT = 4020
const AUTH_PORT_FILE = ".auth-port.json"

/**
 * Gets the runtime state directory.
 */
const getRuntimeRoot = (): string =>
  process.env["PF_RUNTIME_ROOT"] ?? process.cwd()

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
 * Reads the auth port from .auth-port.json in the runtime state directory.
 * Returns undefined if file doesn't exist or contains invalid content.
 */
const readAuthPortFromFile = (): number | undefined => {
  try {
    const filePath = join(getRuntimeRoot(), AUTH_PORT_FILE)
    const content = readFileSync(filePath, "utf-8")
    const parsed: unknown = JSON.parse(content)
    return isValidPortFileContent(parsed) ? parsed.port : undefined
  } catch {
    return undefined
  }
}

export const getFrontendJwt = (): string | undefined =>
  process.env["FRONTEND_JWT_TOKEN"]

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  return Buffer.from(padded, "base64").toString("utf8")
}

interface FrontendJwtConfig {
  readonly clientId: string
  readonly issuer: string
  readonly audience: string
}

const parseFrontendJwtConfig = (jwt: string): FrontendJwtConfig => {
  // Intentionally decode claims without signature verification.
  // This helper is only for local issuer/client/audience discovery from an already
  // provided FRONTEND_JWT_TOKEN; token authenticity is validated by downstream
  // OAuth/JWT verification when the token is actually used.
  const parts = jwt.split(".")
  if (parts.length < 2 || !parts[1]) {
    throw new Error("FRONTEND_JWT_TOKEN is not a valid JWT")
  }

  let payload: unknown
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]))
  } catch {
    throw new Error("FRONTEND_JWT_TOKEN payload is not valid JSON")
  }

  if (typeof payload !== "object" || payload === null) {
    throw new Error("FRONTEND_JWT_TOKEN payload must be an object")
  }

  const claims = payload as {
    readonly iss?: unknown
    readonly aud?: unknown
    readonly properties?: {
      readonly clientId?: unknown
    }
  }

  const clientId = claims.properties?.clientId
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error("FRONTEND_JWT_TOKEN is missing properties.clientId claim")
  }

  if (typeof claims.iss !== "string" || claims.iss.length === 0) {
    throw new Error("FRONTEND_JWT_TOKEN is missing iss claim")
  }

  const audience =
    typeof claims.aud === "string"
      ? claims.aud
      : Array.isArray(claims.aud) && typeof claims.aud[0] === "string"
        ? claims.aud[0]
        : undefined

  if (!audience || audience.length === 0) {
    throw new Error("FRONTEND_JWT_TOKEN is missing aud claim")
  }

  return {
    clientId,
    issuer: stripTrailingSlash(claims.iss),
    audience,
  }
}

const getFrontendJwtConfig = (): FrontendJwtConfig | undefined => {
  const jwt = getFrontendJwt()
  if (!jwt) return undefined
  return parseFrontendJwtConfig(jwt)
}

export const getFrontendJwtIssuer = (): string | undefined => {
  try {
    return getFrontendJwtConfig()?.issuer
  } catch {
    // Callers may already have resolved issuerUrl without parsing this JWT
    // (for example via OAUTH_ISSUER_URL), so malformed tokens are non-fatal here.
    return undefined
  }
}

/**
 * Gets the OAuth issuer URL for shared runtime/backend consumers.
 *
 * Resolution order:
 * 1. OAUTH_ISSUER_URL environment variable (if set)
 * 2. Port from .auth-port.json in the runtime state directory
 * 3. Issuer claim from FRONTEND_JWT_TOKEN
 * 4. Default port 4020 (non-production only)
 *
 * Frontend runtime should use `apps/frontend/lib/auth/issuer.ts`, which
 * prioritizes FRONTEND_JWT_TOKEN and intentionally ignores OAUTH_ISSUER_URL.
 *
 * Note: The frontend does not automatically restart when .auth-port.json changes.
 * If the auth server port changes, the frontend must be manually restarted.
 *
 * @throws Error in production if no issuer can be determined
 */
export const getIssuerUrl = (): string => {
  if (process.env["OAUTH_ISSUER_URL"]) {
    return stripTrailingSlash(process.env["OAUTH_ISSUER_URL"])
  }

  const port = readAuthPortFromFile()
  if (port) {
    return `http://localhost:${port}`
  }

  const frontendJwtConfig = getFrontendJwtConfig()
  if (frontendJwtConfig) {
    return frontendJwtConfig.issuer
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Cannot determine issuer URL in production: set OAUTH_ISSUER_URL or FRONTEND_JWT_TOKEN",
    )
  }

  return `http://localhost:${DEFAULT_AUTH_PORT}`
}

/**
 * Gets the OAuth client id.
 * Uses OAUTH_CLIENT_ID environment variable or defaults to "frontend".
 */
export const getClientId = (): string =>
  getFrontendJwtConfig()?.clientId ??
  process.env["OAUTH_CLIENT_ID"] ??
  "frontend"

/**
 * Gets the OAuth audience for access tokens.
 * Uses OAUTH_AUDIENCE environment variable or defaults to "graphql-api".
 * This specifies which API/service the tokens are intended for.
 */
export const getAudience = (): string =>
  getFrontendJwtConfig()?.audience ??
  process.env["OAUTH_AUDIENCE"] ??
  "graphql-api"
