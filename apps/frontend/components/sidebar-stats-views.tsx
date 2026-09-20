"use client"

import { useQuery } from "@tanstack/react-query"
import { BarChart3Icon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession } from "@/components/auth-provider"
import { useSidebar } from "@/components/ui/sidebar"
import { getActiveRoleCacheKey } from "@/lib/auth/session-role"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { fetchAvailableStatsViews } from "@/lib/graphql/stats-views"
import { cn } from "@/lib/utils"

export function SidebarStatsViews() {
  const pathname = usePathname()
  const client = useGraphqlClient()
  const session = useSession()
  const { closeMobileSidebar } = useSidebar()
  const currentRole = getActiveRoleCacheKey(session)

  const { data: statsViews, isLoading } = useQuery({
    queryKey: ["availableStatsViews", session.userId, currentRole],
    queryFn: () => fetchAvailableStatsViews(client),
    staleTime: 60 * 1000,
  })

  if (isLoading || !statsViews || statsViews.length === 0) {
    return null
  }

  return (
    <>
      {statsViews.map((statsView) => {
        const statsUrl = `/stats${statsView.path}`
        const isActive = pathname === statsUrl

        return (
          <Link
            key={statsView.path}
            href={statsUrl}
            onClick={closeMobileSidebar}
            className={cn(
              "block w-full rounded-xl border px-4 py-3 text-left transition",
              isActive
                ? "border-blue-500 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
                : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-100/70 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800/60",
            )}
          >
            <div className="flex items-center gap-2">
              <BarChart3Icon className="h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{statsView.name}</p>
                {statsView.purpose && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {statsView.purpose}
                  </p>
                )}
              </div>
            </div>
          </Link>
        )
      })}
    </>
  )
}
