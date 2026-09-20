import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface Credentials {
  version: 1
  baseUrl: string
  accessToken: string
  expiresAt: string
  loginAt: string
}

const getCredentialsPath = (): string =>
  process.env["PFCLI_CREDENTIALS_PATH"] ??
  join(homedir(), ".config", "pf", "credentials.json")

export const writeCredentials = (credentials: Credentials): void => {
  const credentialsPath = getCredentialsPath()
  const dir = dirname(credentialsPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  })
}

const isCredentials = (value: unknown): value is Credentials => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    record["version"] === 1 &&
    typeof record["baseUrl"] === "string" &&
    typeof record["accessToken"] === "string" &&
    typeof record["expiresAt"] === "string" &&
    typeof record["loginAt"] === "string"
  )
}

export const readCredentials = (): Credentials | null => {
  try {
    const raw = readFileSync(getCredentialsPath(), "utf8")
    const parsed: unknown = JSON.parse(raw)
    return isCredentials(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const credentialsExpired = (credentials: Credentials): boolean => {
  const expiresAt = new Date(credentials.expiresAt).getTime()
  return Number.isNaN(expiresAt) || Date.now() >= expiresAt
}
