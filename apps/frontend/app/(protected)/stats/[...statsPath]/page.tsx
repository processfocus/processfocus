import { Loader2 } from "lucide-react"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { StatsTimelineData } from "./stats-data-fetcher"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { fetchAvailableStatsViewsServer } from "@/lib/graphql/stats-views-server"

interface PageProps {
  params: Promise<{ statsPath: string[] }>
}

function TimelineSkeleton() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="h-6 w-48 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-2 h-4 w-64 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        </div>
      </div>
      <div className="space-y-1">
        {["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => (
          <div key={key} className="flex items-center gap-2">
            <div className="h-4 w-40 flex-shrink-0 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            <div className="h-5 flex-1 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            <div className="h-4 w-24 flex-shrink-0 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
          </div>
        ))}
      </div>
    </div>
  )
}

async function StatsContent({ params }: PageProps) {
  const { statsPath: statsPathArray } = await params
  const statsPath = `/${statsPathArray.join("/")}`

  const session = await getSessionWithTokenAndExpiry()
  if (!session) {
    notFound()
  }

  const statsViews = await fetchAvailableStatsViewsServer(session.accessToken)
  const statsView = statsViews.find((v) => v.path === statsPath)

  if (!statsView) {
    notFound()
  }

  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          {statsView.name}
        </h1>
        {statsView.purpose && (
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            {statsView.purpose}
          </p>
        )}
      </div>
      <Suspense fallback={<TimelineSkeleton />}>
        <StatsTimelineData
          queryName={statsView.queryName}
          renderer={statsView.renderer}
        />
      </Suspense>
    </div>
  )
}

export default function StatsPage(props: PageProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      }
    >
      <StatsContent {...props} />
    </Suspense>
  )
}
