import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Either, Schema } from "effect"

const CredentialsSchema = Schema.Struct({
  version: Schema.Literal(1),
  baseUrl: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
  expiresAt: Schema.NonEmptyString,
  loginAt: Schema.NonEmptyString,
})

export type Credentials = typeof CredentialsSchema.Type

const defaultCredentialsPath = (): string =>
  join(homedir(), ".config", "pforg", "credentials.json")

const getCredentialsPath = (): string =>
  process.env["PFORG_CREDENTIALS_PATH"] ?? defaultCredentialsPath()

export const writeCredentials = (credentials: Credentials): void => {
  const credentialsPath = getCredentialsPath()
  const directory = dirname(credentialsPath)
  const usesDefaultPath = process.env["PFORG_CREDENTIALS_PATH"] === undefined

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (usesDefaultPath) chmodSync(directory, 0o700)

  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  })
  chmodSync(credentialsPath, 0o600)
}

export const readCredentials = (): Credentials | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getCredentialsPath(), "utf8"),
    )
    const result = Schema.decodeUnknownEither(CredentialsSchema)(parsed)
    return Either.match(result, {
      onLeft: () => null,
      onRight: (credentials) => credentials,
    })
  } catch {
    return null
  }
}

export const credentialsExpired = (
  credentials: Pick<Credentials, "expiresAt">,
  now = Date.now(),
): boolean => {
  const expiresAt = Date.parse(credentials.expiresAt)
  return Number.isNaN(expiresAt) || now >= expiresAt
}
