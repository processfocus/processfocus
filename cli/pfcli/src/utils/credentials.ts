import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import type { ProjectWorkloadPermission } from "@pf/auth-config/runtime"
import { getAuthUrlFromPortFile } from "@pf/frontend-endpoints/port-files"
import {
  type GitHubWorkloadCredentialSource,
  WorkloadAuthenticationError,
  createGitHubWorkloadCredentialSource,
} from "@pf/openauth/github-workload"
import { CliError } from "../errors"

export interface Credentials {
  version: 1
  baseUrl: string
  accessToken: string
  expiresAt: string
  loginAt: string
  workload?: GitHubWorkloadCredentialSource
}

export const isWorkloadAuthenticationFailure = (error: unknown): boolean =>
  error instanceof WorkloadAuthenticationError ||
  (error instanceof Error &&
    "cause" in error &&
    error.cause !== error &&
    isWorkloadAuthenticationFailure(error.cause))

export const acquireAccessToken = (
  credentials: Credentials,
): Effect.Effect<string, CliError> =>
  credentials.workload
    ? credentials.workload.acquire.pipe(
        Effect.map((token) => token.accessToken),
        Effect.mapError(
          (cause) => new CliError({ message: cause.message, cause }),
        ),
      )
    : Effect.succeed(credentials.accessToken)

let workloadSource:
  | { key: string; source: GitHubWorkloadCredentialSource }
  | undefined

export const readWorkloadCredentials = (
  purpose?: ProjectWorkloadPermission,
): Effect.Effect<Credentials | undefined, CliError> =>
  Effect.gen(function* () {
    if (process.env["PFCLI_WORKLOAD_PROVIDER_USER"] !== undefined)
      return yield* new CliError({
        message:
          "PFCLI_WORKLOAD_PROVIDER_USER is retired. Machines must use direct authority.",
      })
    const mode = process.env["PFCLI_AUTH_MODE"]
    if (!mode) return undefined
    if (mode !== "github-workload") {
      return yield* new CliError({
        message: "PFCLI_AUTH_MODE must be github-workload when set.",
      })
    }
    const baseUrl = process.env["PFCLI_BASE_URL"]
    const assertionAudience = process.env["PFCLI_GITHUB_AUDIENCE"]
    const clientId = process.env["PFCLI_WORKLOAD_CLIENT_ID"]
    if (!baseUrl || !assertionAudience) {
      return yield* new CliError({
        message:
          "GitHub Actions OIDC federation mode requires PFCLI_BASE_URL and PFCLI_GITHUB_AUDIENCE.",
      })
    }
    const tokenEndpoint = yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        return `${["localhost", "127.0.0.1"].includes(url.hostname) ? getAuthUrlFromPortFile() : baseUrl.replace(/\/+$/, "")}/oauth/token`
      },
      catch: () => new CliError({ message: "Invalid PFCLI_BASE_URL." }),
    })
    const key = JSON.stringify([
      tokenEndpoint,
      assertionAudience,
      clientId,
      purpose,
    ])
    if (!workloadSource || workloadSource.key !== key) {
      const options = {
        tokenEndpoint,
        assertionAudience,
        ...(clientId ? { clientId } : {}),
        ...(purpose ? { scope: purpose } : {}),
        jobCapability: () => ({
          requestUrl: process.env["ACTIONS_ID_TOKEN_REQUEST_URL"],
          requestToken: process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
        }),
      }
      const source = yield* createGitHubWorkloadCredentialSource(options).pipe(
        Effect.provide(FetchHttpClient.layer),
      )
      workloadSource = { key, source }
    }
    const source = workloadSource.source
    const token = yield* source.acquire.pipe(
      Effect.mapError(
        (cause) => new CliError({ message: cause.message, cause }),
      ),
    )
    return {
      version: 1,
      baseUrl,
      accessToken: token.accessToken,
      expiresAt: new Date(token.expiresAt).toISOString(),
      loginAt: new Date().toISOString(),
      workload: source,
    }
  })

const getCredentialsPath = (): string =>
  process.env["PFCLI_CREDENTIALS_PATH"] ??
  join(homedir(), ".config", "pf", "credentials.json")

export const writeCredentials = (credentials: Credentials): void => {
  if (credentials.workload)
    throw new Error("Federated identity credentials must not be persisted.")
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
