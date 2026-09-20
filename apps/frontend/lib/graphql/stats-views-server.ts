import "server-only"
import { createServerGraphqlClient } from "./server-client"
import { type StatsViewInfo, availableStatsViewsQuery } from "./stats-views"

/**
 * Fetch available stats views server-side using an access token.
 * Use in Server Components.
 */
export async function fetchAvailableStatsViewsServer(
  accessToken: string,
): Promise<StatsViewInfo[]> {
  const client = createServerGraphqlClient(accessToken)
  const result = await client.request(availableStatsViewsQuery)
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic query result
  return (result as any).availableStatsViews as StatsViewInfo[]
}
