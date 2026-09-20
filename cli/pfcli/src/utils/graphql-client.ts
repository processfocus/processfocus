import { negotiateHostingContract } from "@processfocus/hosting-contract"
import { Duration, Effect, Schema } from "effect"
import {
  getWsEndpointFromPortFile,
  readGraphqlPort,
} from "@pf/frontend-endpoints/port-files"
import { CliError } from "../errors"
import {
  type Credentials,
  credentialsExpired,
  readCredentials,
} from "./credentials"

/**
 * GraphQL response structure.
 */
interface GraphqlResponse<TData> {
  data?: TData
  errors?: Array<{
    message?: string
    extensions?: { readonly code?: unknown }
  }>
}

interface GraphqlRequestOptions {
  readonly timeoutMs?: number
}

const AUTH_LOGIN_HINT = 'Authentication required. Run "pfcli auth login".'

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"])

const JsonValue = Schema.parseJson(Schema.Unknown)

const formatGraphqlTimeoutMessage = (timeoutMs: number) => {
  const seconds = timeoutMs / 1000
  const display =
    seconds % 1 === 0
      ? String(seconds)
      : seconds.toFixed(3).replace(/\.?0+$/, "")
  const unit = Number(display) === 1 ? "second" : "seconds"
  return `GraphQL request timed out after ${display} ${unit}`
}

const withGraphqlTimeout = <A>(
  effect: Effect.Effect<A, CliError>,
  timeoutMs: number | undefined,
): Effect.Effect<A, CliError> =>
  timeoutMs === undefined
    ? effect
    : effect.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () =>
            new CliError({
              message: formatGraphqlTimeoutMessage(timeoutMs),
            }),
        }),
      )

/**
 * Resolve the GraphQL endpoint URL from a base URL.
 * For localhost URLs, reads the port from the port file.
 * For remote URLs, appends /graphql to the base URL.
 */
export const resolveGraphqlEndpoint = (baseUrl: string): string => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

  try {
    const parsed = new URL(normalizedBaseUrl)
    if (LOCALHOST_HOSTS.has(parsed.hostname)) {
      return `http://localhost:${readGraphqlPort()}/graphql`
    }
  } catch {
    // Fall back to the provided base URL below.
  }

  return `${normalizedBaseUrl}/graphql`
}

/**
 * Execute a GraphQL query/mutation.
 * Uses native fetch for simplicity and reliability.
 */
export const resolveGraphqlWsEndpoint = (baseUrl: string): string => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

  try {
    const parsed = new URL(normalizedBaseUrl)
    if (LOCALHOST_HOSTS.has(parsed.hostname)) {
      return getWsEndpointFromPortFile()
    }
  } catch {
    // Fall back to the provided base URL below.
  }

  return `${normalizedBaseUrl.replace(/^http/, "ws")}/graphql`
}

export const graphqlRequest = <TData>(
  endpoint: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  options: GraphqlRequestOptions = {},
): Effect.Effect<TData, CliError> =>
  Effect.gen(function* () {
    const requestBody = yield* Schema.encode(JsonValue)({
      query,
      variables,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to encode GraphQL request body",
            cause,
          }),
      ),
    )

    const response = yield* withGraphqlTimeout(
      Effect.tryPromise({
        try: (signal) =>
          fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: requestBody,
            signal,
          }),
        catch: (cause) =>
          new CliError({
            message: "Failed to call GraphQL endpoint",
            cause,
          }),
      }),
      options.timeoutMs,
    )

    if (response.status === 401) {
      return yield* new CliError({ message: AUTH_LOGIN_HINT })
    }

    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await response.text()
          } catch {
            return ""
          }
        },
        catch: (cause) =>
          new CliError({
            message: "Failed to read GraphQL error response body",
            cause,
          }),
      })
      return yield* new CliError({
        message: `GraphQL request failed with ${response.status}: ${body}`,
      })
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new CliError({
          message: "Failed to read GraphQL response body",
          cause,
        }),
    })

    const result = yield* Schema.decodeUnknown(JsonValue)(body).pipe(
      Effect.map((value) => value as GraphqlResponse<TData>),
      Effect.mapError(
        (cause) =>
          new CliError({
            message: `Failed to parse GraphQL response from ${endpoint}: ${body.slice(0, 200)}`,
            cause,
          }),
      ),
    )

    if (result.errors && result.errors.length > 0) {
      const errorMessage = result.errors
        .map((error) => error.message ?? "GraphQL request failed")
        .join(", ")

      if (errorMessage.toLowerCase().includes("unauthenticated")) {
        return yield* new CliError({ message: AUTH_LOGIN_HINT })
      }

      const graphqlErrorCode =
        result.errors.length === 1 &&
        typeof result.errors[0]?.extensions?.code === "string"
          ? result.errors[0].extensions.code
          : undefined

      return yield* new CliError({
        message: `GraphQL error: ${errorMessage}`,
        graphqlErrorMessage: errorMessage,
        ...(graphqlErrorCode === undefined ? {} : { graphqlErrorCode }),
      })
    }

    if (!result.data) {
      return yield* new CliError({
        message: "GraphQL response missing data",
      })
    }

    return result.data
  })

/**
 * Execute a GraphQL query/mutation using credentials.
 * Automatically resolves the endpoint from credentials.baseUrl.
 */
const HOSTING_CONTRACT_QUERY = `
  query HostingContract {
    hostingContract {
      format
      version
      major
      capabilities
    }
  }
`

interface HostingContractResponse {
  readonly hostingContract: {
    readonly format: string
    readonly version: number
    readonly major: number
    readonly capabilities: readonly string[]
  }
}

const HOSTING_CONTRACT_PROBE_TIMEOUT_MS = 10_000

/**
 * Negotiate the hosted Backend contract before any hosted request is issued.
 *
 * Any failure to reach or parse the contract means the Backend does not yet
 * expose it, so the CLI proceeds (backward compatible). Only a definitive
 * unsupported-major response fails -- before any mutation -- with the contract
 * package's upgrade guidance.
 */
export const ensureHostingContractCompatible = (
  credentials: Credentials,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    const probe = yield* graphqlRequest<HostingContractResponse>(
      endpoint,
      credentials.accessToken,
      HOSTING_CONTRACT_QUERY,
      {},
      { timeoutMs: HOSTING_CONTRACT_PROBE_TIMEOUT_MS },
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (probe === undefined) {
      return
    }

    // Match on the stable `_tag` brand (via catchTags) rather than class
    // identity, so the separately installed contract package is recognized
    // across the strongly-versioned public/private boundary (ADR 0020).
    // Parse errors and missing capabilities reflect a newer or structurally
    // different Backend and degrade to "proceed"; only an unsupported major
    // hard-fails -- before any mutation -- with the upgrade guidance.
    yield* negotiateHostingContract(probe.hostingContract).pipe(
      Effect.catchTags({
        UnsupportedHostingContractError: (error) =>
          Effect.fail(
            new CliError({
              message: error.message,
              graphqlErrorMessage: error.upgradeHint,
            }),
          ),
        HostingContractParseError: () => Effect.void,
        UnsupportedHostingCapabilityError: () => Effect.void,
      }),
    )
  })

export const readCredentialsOrFail = (): Effect.Effect<Credentials, CliError> =>
  Effect.gen(function* () {
    const credentials = readCredentials()
    if (!credentials || credentialsExpired(credentials)) {
      return yield* new CliError({ message: AUTH_LOGIN_HINT })
    }

    yield* ensureHostingContractCompatible(credentials)

    return credentials
  })

export const graphqlRequestWithCredentials = <TData>(
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphqlRequestOptions = {},
): Effect.Effect<TData, CliError> =>
  Effect.gen(function* () {
    const credentials = yield* readCredentialsOrFail()
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    return yield* graphqlRequest<TData>(
      endpoint,
      credentials.accessToken,
      query,
      variables,
      options,
    )
  })
