import { Context, Data, Effect, Layer } from "effect"
import { type DocumentNode, print } from "graphql"
import { GraphQLClient } from "graphql-request"
import {
  type AccessToken,
  GraphQLAuthenticationError,
  getAccessToken,
} from "./access-token"
import { getGraphqlEndpoint } from "@/lib/graphql/endpoint"

export class GraphQLRequestError extends Data.TaggedError(
  "GraphQLRequestError",
)<{
  readonly message: string
}> {}

/**
 * Extract the operation name from a GraphQL query/mutation.
 * Falls back to truncated document if no name found.
 */
const getQueryName = (query: string): string => {
  const match = query.match(/(?:query|mutation|subscription)\s+(\w+)/)
  return match?.[1] ?? query.slice(0, 50)
}

type QueryDocument = string | DocumentNode

/**
 * GraphQL client service for making GraphQL requests.
 * Wraps graphql-request with Effect error handling and automatic authentication.
 */
export class GraphQLService extends Context.Service<
  GraphQLService,
  {
    readonly client: GraphQLClient
    readonly request: <T>(
      query: QueryDocument,
      variables?: Record<string, unknown>,
      headers?: HeadersInit,
    ) => Effect.Effect<
      T,
      GraphQLRequestError | GraphQLAuthenticationError,
      AccessToken
    >
  }
>()("@pf/frontend/GraphQLService") {}

/**
 * Creates a GraphQL service layer with the configured endpoint.
 * Uses Effect.sync to defer client creation until the layer is actually used.
 *
 * The client is configured with credentials: "include" to send cookies automatically
 * in browser contexts.
 *
 * Authentication is handled automatically via the request-local AccessToken service - the service
 * will fail with GraphQLAuthenticationError if no token is available. This ensures
 * all GraphQL requests are properly authenticated.
 *
 * Custom headers can still be passed via the headers parameter and will be merged
 * with the automatic Authorization header.
 */
export const GraphQLServiceLive = Layer.effect(
  GraphQLService,
  Effect.sync(() => {
    const client = new GraphQLClient(getGraphqlEndpoint(), {
      credentials: "include",
    })

    return GraphQLService.of({
      client,
      request: <T>(
        query: QueryDocument,
        variables?: Record<string, unknown>,
        headers?: HeadersInit,
      ) =>
        Effect.gen(function* () {
          const { token } = yield* getAccessToken()

          if (!token) {
            return yield* Effect.fail(
              new GraphQLAuthenticationError({
                message:
                  "No authentication token available. User must be logged in to make GraphQL requests.",
              }),
            )
          }

          const authHeaders: HeadersInit = { Authorization: `Bearer ${token}` }
          const mergedHeaders = { ...authHeaders, ...headers }

          // The HTTP client can use a different GraphQL.js major in a consumer install.
          const document = typeof query === "string" ? query : print(query)
          return yield* Effect.tryPromise({
            try: () => client.request<T>(document, variables, mergedHeaders),
            catch: (error) =>
              new GraphQLRequestError({
                message: `GraphQL request failed: ${String(error)}`,
              }),
          }).pipe(
            Effect.withSpan("graphql.request", {
              attributes: {
                "graphql.operation": getQueryName(document),
                "graphql.document": document.slice(0, 200),
              },
            }),
          )
        }),
    })
  }),
)
