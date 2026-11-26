import "server-only"
import { setTimeout } from "node:timers/promises"
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

/** Retry a startup read once without retrying mutations or waiting out an outage. */
export async function retryGraphqlRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    await setTimeout(300)
    return read()
  }
}
