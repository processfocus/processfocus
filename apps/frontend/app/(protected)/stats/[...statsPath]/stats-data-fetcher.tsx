import "server-only"
import {
  JourneyTimeline,
  type TimelineItemData,
} from "@/components/journey-timeline"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

const graphqlNamePattern = /^[_A-Za-z][_0-9A-Za-z]*$/

function assertGraphqlName(name: string, label: string) {
  if (!graphqlNamePattern.test(name)) {
    throw new Error(`Invalid GraphQL ${label}: ${name}`)
  }
}

async function StatsTimelineData({
  queryName,
  renderer,
}: {
  queryName: string
  renderer: string
}) {
  assertGraphqlName(queryName, "stats view query name")

  const session = await getSessionWithTokenAndExpiry()
  if (!session) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
        <p className="font-medium">Authentication required</p>
        <p className="text-sm">Please sign in to view this data.</p>
      </div>
    )
  }

  const client = createServerGraphqlClient(session.accessToken)

  const query = `
    query StatsData {
      ${queryName} {
        items {
          id
          label
          currentStatus
          startDate
          endDate
          segments {
            status
            startDate
            endDate
          }
        }
      }
    }
  `

  try {
    const result = await client.request(query)
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic query result
    const data = (result as any)[queryName] as { items: TimelineItemData[] }

    if (!data || data.items.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No data available for this view yet.
        </div>
      )
    }

    switch (renderer) {
      case "timeline":
        return <JourneyTimeline items={data.items} now={Date.now()} />
      default:
        return (
          <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            Unknown renderer type: {renderer}
          </div>
        )
    }
  } catch (error) {
    console.error("Stats data fetch failed", error)
    return (
      <div className="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
        <p className="font-medium">Error loading data</p>
        <p className="text-sm">
          Something went wrong loading this view. Please try again later.
        </p>
      </div>
    )
  }
}

export { StatsTimelineData }
