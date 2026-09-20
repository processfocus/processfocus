"use client"

import { useQuery } from "@tanstack/react-query"
import { ListIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { useSession } from "@/components/auth-provider"
import { useSidebar } from "@/components/ui/sidebar"
import { getActiveRoleCacheKey } from "@/lib/auth/session-role"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { fetchAvailableLists } from "@/lib/graphql/list-queries"
import { cn } from "@/lib/utils"

/**
 * Sidebar section displaying available lists.
 * Fetches the lists the current user can access and renders them as navigation items.
 */
export function SidebarLists() {
  const pathname = usePathname()
  const client = useGraphqlClient()
  const session = useSession()
  const { closeMobileSidebar } = useSidebar()
  const currentRole = getActiveRoleCacheKey(session)
  const [hoverPrefetchListIds, setHoverPrefetchListIds] = useState<
    Record<string, true>
  >({})

  const { data: lists, isLoading } = useQuery({
    queryKey: ["availableLists", session.userId, currentRole],
    queryFn: () => fetchAvailableLists(client),
    staleTime: 60 * 1000, // Cache for 1 minute
  })

  // Don't render anything if no lists are available or still loading
  if (isLoading || !lists || lists.length === 0) {
    return null
  }

  const enableHoverPrefetch = (listId: string) => {
    setHoverPrefetchListIds((current) => {
      if (current[listId]) {
        return current
      }

      return { ...current, [listId]: true }
    })
  }

  return (
    <>
      {lists.map((list) => {
        const listUrl = `/lists${list.path}`
        const isActive = pathname === listUrl

        return (
          <Link
            key={list.id}
            href={listUrl}
            onClick={closeMobileSidebar}
            onMouseEnter={() => enableHoverPrefetch(list.id)}
            onFocus={() => enableHoverPrefetch(list.id)}
            prefetch={hoverPrefetchListIds[list.id] ? null : false}
            className={cn(
              "block w-full rounded-xl border px-4 py-3 text-left transition",
              isActive
                ? "border-blue-500 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
                : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-100/70 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800/60",
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListIcon className="h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{list.name}</p>
                  {list.purpose && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {list.purpose}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Link>
        )
      })}
    </>
  )
}
