import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Schema } from "effect"
import { CliError } from "../errors"
import {
  type Credentials,
  credentialsExpired,
  readCredentials,
} from "./credentials"

const AUTH_LOGIN_HINT =
  'Authentication required. Run "pforg auth login <base-url>".'
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"])
const DEFAULT_GRAPHQL_PORT = 4000

const GraphqlPortFileSchema = Schema.parseJson(
  Schema.Struct({ port: Schema.Number }),
)

const GraphqlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
})

const GraphqlResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  ),
  errors: Schema.optional(Schema.Array(GraphqlErrorSchema)),
})

const ParsedGraphqlResponseSchema = Schema.parseJson(GraphqlResponseSchema)

const redactAccessToken = (message: string, accessToken: string): string =>
  message.replaceAll(accessToken, "[REDACTED]")

const readGraphqlPort = (): number => {
  const runtimeRoot =
    process.env["PF_RUNTIME_ROOT"] ??
    process.env["NX_WORKSPACE_ROOT"] ??
    process.cwd()

  try {
    const contents = readFileSync(
      join(runtimeRoot, ".graphql-port.json"),
      "utf8",
    )
    return Schema.decodeUnknownSync(GraphqlPortFileSchema)(contents).port
  } catch {
    return DEFAULT_GRAPHQL_PORT
  }
}

const resolveGraphqlEndpoint = (baseUrl: string): string => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

  try {
    const parsed = new URL(normalizedBaseUrl)
    if (LOCALHOST_HOSTS.has(parsed.hostname)) {
      return `http://localhost:${String(readGraphqlPort())}/graphql`
    }
  } catch {
    // Credentials are validated when written; preserve the normal remote path
    // fallback if an older credentials file contains an unusual base URL.
  }

  return `${normalizedBaseUrl}/graphql`
}

const readCredentialsOrFail: Effect.Effect<Credentials, CliError> = Effect.gen(
  function* () {
    const credentials = readCredentials()
    if (!credentials || credentialsExpired(credentials)) {
      return yield* new CliError({ message: AUTH_LOGIN_HINT })
    }

    return credentials
  },
)

export interface GraphqlRequestOptions {
  readonly variables?: Readonly<Record<string, unknown>>
  readonly errorMessagePrefix?: string
}

export const graphqlRequest = (
  query: string,
  options: GraphqlRequestOptions = {},
): Effect.Effect<Record<string, unknown>, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const credentials = yield* readCredentialsOrFail
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)
    const client = yield* HttpClient.HttpClient
    let request = HttpClientRequest.post(endpoint)
    request = HttpClientRequest.setHeaders(request, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
    })
    request = HttpClientRequest.bodyUnsafeJson(request, {
      query,
      variables: options.variables ?? {},
    })

    const response = yield* client.execute(request).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new CliError({ message: "Failed to call GraphQL endpoint", cause }),
      ),
    )

    if (response.status === 401) {
      return yield* new CliError({ message: AUTH_LOGIN_HINT })
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new CliError({
        message: `GraphQL request failed with status ${String(response.status)}`,
      })
    }

    const body = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to read GraphQL response body",
            cause,
          }),
      ),
    )

    const result = yield* Schema.decodeUnknown(ParsedGraphqlResponseSchema)(
      body,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to parse GraphQL response",
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

      return yield* new CliError({
        message: `${options.errorMessagePrefix ?? "GraphQL error: "}${redactAccessToken(
          errorMessage,
          credentials.accessToken,
        )}`,
      })
    }

    if (!result.data) {
      return yield* new CliError({ message: "GraphQL response missing data" })
    }

    return result.data
  })
