import { Data, Effect, Schedule } from "effect"
import {
  getAuthUrl as getAuthUrlBase,
  getBaseUrl,
  getGraphqlEndpoint as getGraphqlEndpointBase,
} from "@pf/frontend-endpoints"
import {
  getAuthUrlFromPortFile,
  getGraphqlEndpointFromPortFile,
} from "@pf/frontend-endpoints/port-files"
import { withPausedLocalWorker } from "./local-worker-pause"
import { sleep } from "./sleep"

/**
 * When BASE_URL is "http://localhost" (no port), use port files.
 * Otherwise use the standard endpoint functions.
 */
const isLocalhostBaseUrl = (): boolean => {
  const baseUrl = getBaseUrl()
  return baseUrl === "http://localhost" || baseUrl === "https://localhost"
}

const getAuthUrl = (): string =>
  isLocalhostBaseUrl() ? getAuthUrlFromPortFile() : getAuthUrlBase()

const getGraphqlEndpoint = (): string =>
  isLocalhostBaseUrl()
    ? getGraphqlEndpointFromPortFile()
    : getGraphqlEndpointBase()

interface AuthResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface RequestRoleResponse {
  success: boolean
  error?: string
}

// E2E starts one short-lived runtime per process, so these tokens do not need TTL eviction.
const roleAuthCache = new Map<string, AuthResponse>()
const providerUserAuthCache = new Map<string, AuthResponse>()

const transientGraphqlFailureMarkers = [
  "Database operation failed",
  "SQLITE_BUSY",
  "database is locked",
  "SQL statements in progress",
] as const

const isTransientGraphqlFailure = (error: string | undefined): boolean =>
  error !== undefined &&
  transientGraphqlFailureMarkers.some((marker) => error.includes(marker))

const postGraphqlWithRetry = async (
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const endpoint = getGraphqlEndpoint()
  const maxAttempts = 3

  for (let attempt = 1; ; attempt++) {
    let response: Response

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      if (attempt < maxAttempts) {
        await sleep(150 * attempt)
        continue
      }

      throw error
    }

    if (response.status >= 500 && response.status < 600) {
      if (attempt < maxAttempts) {
        await sleep(150 * attempt)
        continue
      }

      throw new Error(
        `GraphQL request failed: ${response.status} ${response.statusText}`,
      )
    }

    if (!response.ok) {
      throw new Error(
        `GraphQL request failed: ${response.status} ${response.statusText}`,
      )
    }

    return response
  }
}

class TransientAuthError extends Data.TaggedError("TransientAuthError")<{
  readonly response: AuthResponse
}> {}

class MissingSecretError extends Data.TaggedError("MissingSecretError")<{
  readonly message: string
}> {}

class MissingClientCredentialsError extends Data.TaggedError(
  "MissingClientCredentialsError",
)<{
  readonly message: string
}> {}

class FetchError extends Data.TaggedError("FetchError")<{
  readonly error: unknown
}> {}

class ParseError extends Data.TaggedError("ParseError")<{
  readonly error: unknown
  readonly body: string
}> {}

const authenticateWithClient = (
  clientId: string,
  clientSecret: string,
  scope?: string,
) =>
  Effect.gen(function* () {
    if (!clientId || !clientSecret) {
      return yield* new MissingClientCredentialsError({
        message: "Client credentials are required",
      })
    }

    const body = scope
      ? `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`
      : "grant_type=client_credentials"

    const authUrl = `${getAuthUrl()}/oauth/token`
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(authUrl, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      catch: (error) => {
        console.error(
          `[auth] fetch ${authUrl} failed:`,
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        )
        return new FetchError({ error })
      },
    })

    const responseText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => {
        console.error(`[auth] reading response body failed:`, error)
        return new FetchError({ error })
      },
    })

    if (!response.ok) {
      console.error(
        `[auth] ${authUrl} returned ${response.status} ${response.statusText}:`,
        responseText.slice(0, 500),
      )
    }

    // In CI the auth server can briefly return a plain-text 5xx while SQLite is
    // contended. Treat any 5xx as transient so role/email auth flows retry.
    if (response.status >= 500 && response.status <= 599) {
      console.warn(`[auth] ${response.status} is transient, will retry`)
      return yield* new TransientAuthError({
        response: {
          error: "server_error",
          error_description: `${response.status}: ${responseText.slice(0, 200)}`,
        },
      })
    }

    const result = yield* Effect.try({
      try: () => JSON.parse(responseText) as AuthResponse,
      catch: (error) => {
        console.error(
          `[auth] JSON parse failed for ${authUrl} (status ${response.status}):`,
          responseText.slice(0, 500),
        )
        return new ParseError({ error, body: responseText })
      },
    })

    // Retry on server_error (transient failure)
    if (result.error === "server_error") {
      return yield* new TransientAuthError({ response: result })
    }

    return result
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("150 millis").pipe(
        Schedule.compose(Schedule.recurs(5)),
      ),
      while: (e) => e instanceof TransientAuthError,
    }),
  )

const authenticate = (scope?: string) =>
  Effect.gen(function* () {
    const secret = process.env["CI_PIPELINE_SECRET"]
    if (!secret) {
      return yield* new MissingSecretError({
        message: "CI_PIPELINE_SECRET environment variable is not set",
      })
    }

    return yield* authenticateWithClient("ci-pipeline", secret, scope)
  })

export const runAuthenticate = (scope?: string): Promise<AuthResponse> =>
  Effect.runPromise(authenticate(scope))

export const runAuthenticateAsFrontend = (): Promise<AuthResponse> => {
  const frontendJwtToken = process.env["FRONTEND_JWT_TOKEN"]
  if (frontendJwtToken && frontendJwtToken.length > 0) {
    return Promise.resolve({ access_token: frontendJwtToken })
  }

  const clientId = process.env["OAUTH_CLIENT_ID"] ?? "frontend"
  const audience = process.env["OAUTH_AUDIENCE"] ?? "graphql-api"
  const clientSecret = process.env["OAUTH_CLIENT_SECRET"]
  if (!clientSecret) {
    return Promise.resolve({
      error: "invalid_client",
      error_description:
        "FRONTEND_JWT_TOKEN or OAUTH_CLIENT_SECRET is required for frontend authentication",
    })
  }

  return Effect.runPromise(
    authenticateWithClient(clientId, clientSecret, audience),
  )
}

/**
 * Call the requestRole GraphQL mutation to pre-authorize a role for M2M access.
 * This writes to permitted_client_role table and must be called before
 * authenticating with a role scope.
 */
const requestRole = async (
  accessToken: string,
  rolePath: string,
): Promise<RequestRoleResponse> => {
  const maxAttempts = 4

  for (let attempt = 1; ; attempt++) {
    const response = await postGraphqlWithRetry(accessToken, {
      query: `
        mutation RequestRole($rolePath: String!) {
          requestRole(rolePath: $rolePath) {
            success
            error
          }
        }
      `,
      variables: { rolePath },
    })
    const result = (await response.json()) as {
      data?: { requestRole: RequestRoleResponse }
      errors?: Array<{ message: string }>
    }
    if (result.errors?.length) {
      const error = result.errors[0]?.message ?? "Unknown error"
      console.error(
        `[requestRole] GraphQL errors for ${rolePath}:`,
        result.errors,
      )
      if (isTransientGraphqlFailure(error) && attempt < maxAttempts) {
        await sleep(150 * attempt)
        continue
      }
      return {
        success: false,
        error,
      }
    }
    const roleResult = result.data?.requestRole ?? {
      success: false,
      error: "Request failed",
    }
    if (!roleResult.success) {
      console.error(`[requestRole] Failed for ${rolePath}:`, roleResult.error)
      if (
        isTransientGraphqlFailure(roleResult.error) &&
        attempt < maxAttempts
      ) {
        await sleep(150 * attempt)
        continue
      }
    }
    return roleResult
  }
}

/**
 * Call the requestProviderUserPermissions GraphQL mutation to pre-authorize an email for M2M access.
 * This writes to permitted_client_email table and must be called before
 * authenticating with an email scope.
 */
const requestProviderUserPermissions = async (
  accessToken: string,
  email: string,
): Promise<{ success: boolean; error?: string }> => {
  const maxAttempts = 4

  for (let attempt = 1; ; attempt++) {
    const response = await postGraphqlWithRetry(accessToken, {
      query: `
        mutation RequestProviderUserPermissions($email: String!) {
          requestProviderUserPermissions(email: $email) {
            success
            error
          }
        }
      `,
      variables: { email },
    })
    const result = (await response.json()) as {
      data?: {
        requestProviderUserPermissions: {
          success: boolean
          error?: string
        }
      }
      errors?: Array<{ message: string }>
    }
    if (result.errors?.length) {
      const error = result.errors[0]?.message ?? "Unknown error"
      console.error(
        `[requestProviderUserPermissions] GraphQL errors for ${email}:`,
        result.errors,
      )
      if (isTransientGraphqlFailure(error) && attempt < maxAttempts) {
        await sleep(150 * attempt)
        continue
      }
      return {
        success: false,
        error,
      }
    }
    const permResult = result.data?.requestProviderUserPermissions ?? {
      success: false,
      error: "Request failed",
    }
    if (!permResult.success) {
      console.error(
        `[requestProviderUserPermissions] Failed for ${email}:`,
        permResult.error,
      )
      if (
        isTransientGraphqlFailure(permResult.error) &&
        attempt < maxAttempts
      ) {
        await sleep(150 * attempt)
        continue
      }
    }
    return permResult
  }
}

/**
 * Authenticate M2M client with a role using the two-step flow.
 *
 * This makes TWO authentication calls:
 *   1. Authenticate without role to get base token
 *   2. Call requestRole GraphQL mutation (Cedar authorization)
 *   3. Re-authenticate with role scope
 *
 * For direct role scope authentication (will fail without prior requestRole),
 * use {@link runAuthenticate} directly.
 */
export const runAuthenticateWithRole = async (
  role: string,
): Promise<AuthResponse> => {
  const cached = roleAuthCache.get(role)
  if (cached?.access_token) {
    return cached
  }

  console.log(`[auth] runAuthenticateWithRole("${role}") step 1: base token`)
  // Step 1: Get base token (no role scope)
  const baseAuth = await runAuthenticate()
  if (!baseAuth.access_token) {
    console.error(`[auth] step 1 failed for "${role}":`, baseAuth)
    return baseAuth // Return error
  }
  const baseAccessToken = baseAuth.access_token
  console.log(`[auth] step 1 OK for "${role}"`)

  return await withPausedLocalWorker(async () => {
    // Step 2: Request role via GraphQL mutation
    console.log(`[auth] step 2: requestRole("${role}")`)
    const roleResult = await requestRole(baseAccessToken, role)
    if (!roleResult.success) {
      console.error(`[auth] step 2 failed for "${role}":`, roleResult)
      return {
        error: "invalid_scope",
        error_description: roleResult.error ?? "Role request failed",
      }
    }
    console.log(`[auth] step 2 OK for "${role}"`)

    // Step 3: Re-authenticate with role scope
    console.log(`[auth] step 3: authenticate with role scope "${role}"`)
    const result = await runAuthenticate(`role:${encodeURIComponent(role)}`)
    console.log(
      `[auth] step 3 ${result.access_token ? "OK" : "FAILED"} for "${role}"`,
      result.access_token ? "" : result,
    )
    if (result.access_token) {
      roleAuthCache.set(role, result)
    }
    return result
  })
}

/**
 * Authenticate M2M client as a provider user using the two-step flow.
 *
 * This makes TWO authentication calls:
 *   1. Authenticate without email to get base token
 *   2. Call requestProviderUserPermissions GraphQL mutation (Cedar authorization)
 *   3. Re-authenticate with email scope
 */
export const runAuthenticateAsProviderUser = async (
  email: string,
): Promise<AuthResponse> => {
  const cached = providerUserAuthCache.get(email)
  if (cached?.access_token) {
    return cached
  }

  // Step 1: Get base token (no email scope)
  const baseAuth = await runAuthenticate()
  if (!baseAuth.access_token) {
    return baseAuth // Return error
  }
  const baseAccessToken = baseAuth.access_token

  return await withPausedLocalWorker(async () => {
    // Step 2: Request provider user permission via GraphQL mutation
    const permResult = await requestProviderUserPermissions(
      baseAccessToken,
      email,
    )
    if (!permResult.success) {
      return {
        error: "invalid_scope",
        error_description:
          permResult.error ?? "Email permission request failed",
      }
    }

    // Step 3: Re-authenticate with email scope
    const result = await runAuthenticate(`email:${email}`)
    if (result.access_token) {
      providerUserAuthCache.set(email, result)
    }
    return result
  })
}
