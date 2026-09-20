import { Context, Effect, Layer } from "effect"
import { GraphQLClient, type RequestDocument } from "graphql-request"
import {
  type AccessToken,
  GraphQLAuthenticationError,
  getAccessToken,
} from "./access-token"
import { getGraphqlEndpoint } from "@/lib/graphql/endpoint"

/**
 * Extract the operation name from a GraphQL query/mutation.
 * Falls back to truncated document if no name found.
 */
const getQueryName = (doc: RequestDocument): string => {
  const str = String(doc)
  const match = str.match(/(?:query|mutation|subscription)\s+(\w+)/)
  return match?.[1] ?? str.slice(0, 50)
}

/**
 * GraphQL client service for making GraphQL requests.
 * Wraps graphql-request with Effect error handling and automatic authentication.
 */
export class GraphQLService extends Context.Tag("@pf/frontend/GraphQLService")<
  GraphQLService,
  {
    readonly client: GraphQLClient
    readonly request: <T>(
      query: RequestDocument,
      variables?: Record<string, unknown>,
      headers?: HeadersInit,
    ) => Effect.Effect<T, Error | GraphQLAuthenticationError, AccessToken>
  }
>() {}

/**
 * Creates a GraphQL service layer with the configured endpoint.
 * Uses Effect.sync to defer client creation until the layer is actually used.
 *
 * The client is configured with credentials: "include" to send cookies automatically
 * in browser contexts.
 *
 * Authentication is handled automatically via the AccessToken FiberRef - the service
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
        query: RequestDocument,
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

          return yield* Effect.tryPromise({
            try: () => client.request<T>(query, variables, mergedHeaders),
            catch: (error) =>
              new Error(`GraphQL request failed: ${String(error)}`),
          }).pipe(
            Effect.withSpan("graphql.request", {
              attributes: {
                "graphql.operation": getQueryName(query),
                "graphql.document": String(query).slice(0, 200),
              },
            }),
          )
        }),
    })
  }),
)
