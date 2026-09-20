import "server-only"
import { GraphQLClient } from "graphql-request"
import { getGraphqlEndpoint } from "./endpoint"

/**
 * Creates a GraphQL client for server-side use with Bearer token auth.
 * Use this in Server Components and Server Actions.
 */
export function createServerGraphqlClient(accessToken: string): GraphQLClient {
  return new GraphQLClient(getGraphqlEndpoint(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
