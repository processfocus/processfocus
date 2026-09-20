import { Console, Effect } from "effect"
import { getAuthUrlFromPortFile } from "@pf/frontend-endpoints/port-files"
import { AuthLoginError } from "../../errors"
import { writeCredentials } from "../../utils/credentials"
import {
  graphqlRequest,
  resolveGraphqlEndpoint,
} from "../../utils/graphql-client"
import { openBrowser, validateBrowserUrl } from "../../utils/open-browser"
import { startCallbackServer } from "./callback-server"
import { credentialDeadline } from "./credential-deadline"

interface AuthLoginOptions {
  readonly ciProviderUser?: string
}

interface OAuthTokenResponse {
  readonly accessToken: string
  readonly expiresAt: number
}

interface OAuthTokenJson {
  readonly access_token: string
  readonly expires_in: number
}

interface RequestProviderUserPermissionsResponse {
  readonly requestProviderUserPermissions: {
    readonly success: boolean
    readonly error?: string | null
  }
}

const REQUEST_PROVIDER_USER_PERMISSIONS_MUTATION = `
  mutation RequestProviderUserPermissions($email: String!) {
    requestProviderUserPermissions(email: $email) {
      success
      error
    }
  }
`

const CI_PIPELINE_CLIENT_ID = "ci-pipeline"

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"])

const isOAuthTokenJson = (value: unknown): value is OAuthTokenJson => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record["access_token"] === "string" &&
    record["access_token"].length > 0 &&
    typeof record["expires_in"] === "number" &&
    Number.isFinite(record["expires_in"]) &&
    record["expires_in"] > 0
  )
}

const toOAuthTokenResponse = (value: OAuthTokenJson): OAuthTokenResponse => {
  return {
    accessToken: value.access_token,
    expiresAt: credentialDeadline(value.access_token, value.expires_in),
  }
}

const formatOAuthError = (value: unknown): string => {
  if (typeof value !== "object" || value === null) {
    return "OAuth token response did not contain an access token"
  }

  const record = value as Record<string, unknown>
  const error = typeof record["error"] === "string" ? record["error"] : null
  const description =
    typeof record["error_description"] === "string"
      ? record["error_description"]
      : null

  if (error && description) {
    return `${error}: ${description}`
  }

  return error ?? "OAuth token response did not contain an access token"
}

const resolveAuthTokenEndpoint = (baseUrl: string): string => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

  try {
    const parsed = new URL(normalizedBaseUrl)
    if (LOCALHOST_HOSTS.has(parsed.hostname)) {
      return `${getAuthUrlFromPortFile()}/oauth/token`
    }
  } catch {
    // Fall back to appending the OAuth path to the provided value below.
  }

  return `${normalizedBaseUrl}/oauth/token`
}

const requestClientCredentialsToken = (
  authTokenEndpoint: string,
  clientSecret: string,
  scope?: string,
) =>
  Effect.gen(function* () {
    const body = new URLSearchParams({ grant_type: "client_credentials" })
    if (scope) {
      body.set("scope", scope)
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(authTokenEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${CI_PIPELINE_CLIENT_ID}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      catch: (cause) =>
        new AuthLoginError({
          message: "Failed to call OAuth token endpoint",
          cause,
        }),
    })

    const responseText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new AuthLoginError({
          message: "Failed to read OAuth token response body",
          cause,
        }),
    })

    const responseJson = yield* Effect.try({
      try: () => JSON.parse(responseText) as unknown,
      catch: (cause) =>
        new AuthLoginError({
          message: `Failed to parse OAuth token response: ${responseText.slice(0, 200)}`,
          cause,
        }),
    })

    if (!response.ok || !isOAuthTokenJson(responseJson)) {
      return yield* new AuthLoginError({
        message: `OAuth token request failed: ${formatOAuthError(responseJson)}`,
      })
    }

    return yield* Effect.try({
      try: () => toOAuthTokenResponse(responseJson),
      catch: (cause) =>
        new AuthLoginError({
          message:
            cause instanceof Error
              ? cause.message
              : "Invalid login credential expiry",
          cause,
        }),
    })
  })

const writeLoginCredentials = (
  baseUrl: string,
  accessToken: string,
  deadline: number,
) =>
  Effect.try({
    try: () => {
      const now = Date.now()
      const expiresAt = new Date(deadline)
      if (deadline <= now) {
        throw new AuthLoginError({
          message: "Login expired. Run pfcli auth login again.",
        })
      }
      writeCredentials({
        version: 1,
        baseUrl,
        accessToken,
        expiresAt: expiresAt.toISOString(),
        loginAt: new Date(now).toISOString(),
      })
    },
    catch: (error) =>
      error instanceof AuthLoginError
        ? error
        : new AuthLoginError({
            message: "Failed to write credentials",
            cause: error,
          }),
  })

const runCiProviderUserLogin = (baseUrl: string, email: string) =>
  Effect.gen(function* () {
    const trimmedEmail = email.trim()
    if (trimmedEmail.length === 0) {
      return yield* new AuthLoginError({
        message: "--ci-provider-user must not be empty",
      })
    }

    const ciPipelineSecret = process.env["CI_PIPELINE_SECRET"]
    if (!ciPipelineSecret) {
      return yield* new AuthLoginError({
        message:
          "CI_PIPELINE_SECRET environment variable is required for --ci-provider-user",
      })
    }

    const authTokenEndpoint = resolveAuthTokenEndpoint(baseUrl)
    const graphqlEndpoint = resolveGraphqlEndpoint(baseUrl)

    const baseToken = yield* requestClientCredentialsToken(
      authTokenEndpoint,
      ciPipelineSecret,
    )

    const permissionResult =
      yield* graphqlRequest<RequestProviderUserPermissionsResponse>(
        graphqlEndpoint,
        baseToken.accessToken,
        REQUEST_PROVIDER_USER_PERMISSIONS_MUTATION,
        { email: trimmedEmail },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AuthLoginError({
              message: cause.message,
              cause,
            }),
        ),
      )

    if (!permissionResult.requestProviderUserPermissions.success) {
      return yield* new AuthLoginError({
        message:
          permissionResult.requestProviderUserPermissions.error ??
          `CI provider user permission denied for ${trimmedEmail}`,
      })
    }

    const providerUserToken = yield* requestClientCredentialsToken(
      authTokenEndpoint,
      ciPipelineSecret,
      `email:${trimmedEmail}`,
    )

    yield* writeLoginCredentials(
      baseUrl,
      providerUserToken.accessToken,
      providerUserToken.expiresAt,
    )

    yield* Console.log("Login successful! Credentials stored.")
  })

/**
 * `pfcli auth login` — browser OAuth login, or CI provider-user login when
 * options.ciProviderUser is provided.
 *
 * 1. Starts an ephemeral callback server on a random port
 * 2. Opens the browser to {BASE_URL}/cli-auth?port={port}
 * 3. Waits for the callback with tokens (2-min timeout)
 * 4. Stores credentials to ~/.config/pf/credentials.json
 */
export const runAuthLogin = (baseUrl: string, options: AuthLoginOptions = {}) =>
  Effect.gen(function* () {
    if (options.ciProviderUser) {
      return yield* runCiProviderUserLogin(baseUrl, options.ciProviderUser)
    }

    const loginUrl = yield* Effect.try({
      try: () => validateBrowserUrl(new URL("/cli-auth", baseUrl).toString()),
      catch: (cause) =>
        new AuthLoginError({
          message: cause instanceof Error ? cause.message : "Invalid login URL",
          cause,
        }),
    })

    const tokens = yield* Effect.acquireUseRelease(
      startCallbackServer,
      (server) =>
        Effect.gen(function* () {
          loginUrl.searchParams.set("port", String(server.port))
          loginUrl.searchParams.set("state", server.state)

          yield* openBrowser(loginUrl.toString())
          yield* Console.log("Waiting for login...")

          return yield* Effect.tryPromise({
            try: () => server.tokens,
            catch: (error) =>
              new AuthLoginError({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
          })
        }),
      (server) => Effect.sync(() => server.stop()),
    )

    yield* writeLoginCredentials(baseUrl, tokens.accessToken, tokens.expiresAt)

    yield* Console.log("Login successful! Credentials stored.")
  })
