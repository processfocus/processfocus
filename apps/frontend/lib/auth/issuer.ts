import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { getFrontendJwt, stripTrailingSlash } from "@pf/auth-session"

const DEFAULT_AUTH_PORT = 4020
const AUTH_PORT_FILE = ".auth-port.json"

interface PortFileContent {
  readonly port: number
}

const getWorkspaceRoot = (): string =>
  process.env["PF_RUNTIME_ROOT"] ?? resolve(process.cwd(), "../..")

const isValidPortFileContent = (value: unknown): value is PortFileContent => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  return "port" in record && typeof record["port"] === "number"
}

const readAuthPortFromFile = (): number | undefined => {
  try {
    const filePath = join(getWorkspaceRoot(), AUTH_PORT_FILE)
    const content = readFileSync(filePath, "utf-8")
    const parsed: unknown = JSON.parse(content)
    return isValidPortFileContent(parsed) ? parsed.port : undefined
  } catch {
    return undefined
  }
}

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  return Buffer.from(padded, "base64").toString("utf8")
}

const parseJwtIssuer = (jwt: string): string => {
  const parts = jwt.split(".")
  if (parts.length !== 3 || !parts[1]) {
    throw new Error(
      `FRONTEND_JWT_TOKEN is not a valid JWT (expected 3 dot-separated parts, got ${parts.length}). Value starts with: "${jwt.slice(0, 60)}..."`,
    )
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

  const issuer = (payload as { readonly iss?: unknown }).iss
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new Error("FRONTEND_JWT_TOKEN is missing iss claim")
  }

  return stripTrailingSlash(issuer)
}

const isLoopbackIssuer = (issuer: string): boolean => {
  try {
    const url = new URL(issuer)
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    )
  } catch {
    return false
  }
}

const requireFrontendJwt = (): string => {
  const jwt = getFrontendJwt()
  if (jwt === undefined) {
    throw new Error(
      "FRONTEND_JWT_TOKEN is not set. Run 'pfcli refresh-frontend-jwt' to create one, then 'pfcli get-frontend-jwt' to verify it exists.",
    )
  }

  if (jwt === "") {
    throw new Error(
      "FRONTEND_JWT_TOKEN is empty (the 'pfcli get-frontend-jwt' command likely failed). Check that PF_ORG is set and points to the correct org directory.",
    )
  }

  return jwt
}

interface FrontendAuthClientConfig {
  readonly jwt: string
  readonly issuer: string
}

export const getFrontendAuthClientConfig = (): FrontendAuthClientConfig => {
  const jwt = requireFrontendJwt()
  return {
    jwt,
    issuer: getIssuerUrl(),
  }
}

export const getIssuerUrl = (): string => {
  const jwt = getFrontendJwt()
  if (jwt !== undefined && jwt !== "") {
    const jwtIssuer = parseJwtIssuer(jwt)
    const port = readAuthPortFromFile()
    if (
      process.env["NODE_ENV"] !== "production" &&
      port &&
      isLoopbackIssuer(jwtIssuer)
    ) {
      return `http://localhost:${port}`
    }
    return jwtIssuer
  }

  const port = readAuthPortFromFile()
  if (port) {
    return `http://localhost:${port}`
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Cannot determine frontend issuer URL in production: set FRONTEND_JWT_TOKEN",
    )
  }

  return `http://localhost:${DEFAULT_AUTH_PORT}`
}

/**
 * Validates frontend JWT config during startup.
 *
 * When FRONTEND_JWT_TOKEN is present, this verifies it can be parsed and has an
 * issuer claim. Local loopback auth ports are allowed to drift while the signed
 * client identity remains valid.
 */
export const validateFrontendJwtIssuer = (): void => {
  const jwt = getFrontendJwt()
  if (!jwt) {
    return
  }

  const jwtIssuer = parseJwtIssuer(jwt)
  const port = readAuthPortFromFile()
  if (
    process.env["NODE_ENV"] !== "production" &&
    port &&
    !isLoopbackIssuer(jwtIssuer)
  ) {
    throw new Error(
      `FRONTEND_JWT_TOKEN issuer mismatch: JWT has non-local iss="${jwtIssuer}" but a local authentication server is running at "http://localhost:${port}". Remove FRONTEND_JWT_TOKEN or refresh it for the local auth server.`,
    )
  }
}
