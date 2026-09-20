import "server-only"
import type { CurrentProviderUserQuery } from "./generated/gql/graphql"
import { fetchCurrentProviderUser } from "./graphql/provider-user-queries"
import { createServerGraphqlClient } from "./graphql/server-client"

export type CurrentProviderUser = NonNullable<
  CurrentProviderUserQuery["currentProviderUser"]
>

/**
 * Fetches the current provider user for server-side prefetching.
 * Requires an access token - caller is responsible for obtaining it.
 *
 * Returns null on failure to allow graceful degradation - the Header component
 * will fall back to client-side fetching via useQuery.
 */
export async function getCurrentProviderUser(
  accessToken: string,
): Promise<CurrentProviderUser | null> {
  try {
    const client = createServerGraphqlClient(accessToken)
    return await fetchCurrentProviderUser(client)
  } catch (error) {
    console.warn(
      "Failed to fetch current provider user:",
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}
