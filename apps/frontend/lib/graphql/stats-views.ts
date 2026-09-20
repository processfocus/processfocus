import type { GraphQLClient } from "graphql-request"

export interface StatsViewInfo {
  readonly path: string
  readonly name: string
  readonly purpose: string | null
  readonly renderer: string
  readonly queryName: string
}

export const availableStatsViewsQuery = `
  query AvailableStatsViews {
    availableStatsViews {
      path
      name
      purpose
      renderer
      queryName
    }
  }
`

/**
 * Fetch available stats views client-side using a GraphQL client
 * with cookie auth. Use in client components.
 */
export async function fetchAvailableStatsViews(
  client: GraphQLClient,
): Promise<StatsViewInfo[]> {
  const result = await client.request(availableStatsViewsQuery)
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic query result
  return (result as any).availableStatsViews as StatsViewInfo[]
}
