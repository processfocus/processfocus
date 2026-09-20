"use client"

import {
  ChartNetwork,
  LogOut,
  type LucideIcon,
  Shield,
  UserCog,
} from "lucide-react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Button } from "@pf/shadcn-components"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { performClientLogout } from "@/lib/auth/logout"
import {
  type ShellSectionKey,
  getShellSectionDescription,
  getShellSectionLabel,
  isExecutionsPath,
  shouldPrefetchShellLinks,
} from "@/lib/mobile-shell-policy"
import type { OrgIdentity } from "@/lib/types/org-identity"
import { cn } from "@/lib/utils"

// Dynamically import TodoCountBadge with SSR disabled - it depends on
// TodoCollectionProvider which uses RxDB/TanStack DB that crash Lambda during SSR
const TodoCountBadge = dynamic(() => import("./todo-count-badge"), {
  ssr: false,
})

// Dynamically import SidebarLists with SSR disabled - it uses useQuery for client-side data fetching
const SidebarLists = dynamic(
  () => import("./sidebar-lists").then((mod) => mod.SidebarLists),
  { ssr: false },
)

const SidebarStatsViews = dynamic(
  () => import("./sidebar-stats-views").then((mod) => mod.SidebarStatsViews),
  { ssr: false },
)

interface AppSidebarProps {
  orgIdentity: OrgIdentity | null
  version: string
  showSettings: boolean
  showAuthorization: boolean
}

// Menu items.
const items: Array<{
  id: ShellSectionKey
  title: string
  description: string
  url: string
  icon?: LucideIcon
}> = [
  {
    id: "dashboard",
    title: "Dashboard",
    description: "Summary metrics and SLA insights",
    url: "/",
  },
  {
    id: "todos",
    title: "My To-Dos",
    description: "Tasks that need your attention",
    url: "/to-dos",
  },
  {
    id: "processes",
    title: "Processes",
    description: "Browse and start business processes",
    url: "/processes",
  },
  {
    id: "executions",
    title: "Executions",
    description: "Monitor live and historical instances",
    url: "/executions",
  },
  {
    id: "orgchart",
    title: "Org Chart",
    description: "View organization structure and roles",
    url: "/org-chart",
    icon: ChartNetwork,
  },
  {
    id: "settings",
    title: "Profile & Settings",
    description: "Preferences, notifications, and roles",
    url: "/settings",
    icon: UserCog,
  },
  {
    id: "authorization",
    title: "Authorisation",
    description: "Policies, schema, and access",
    url: "/settings/cedar",
    icon: Shield,
  },
]

// Eligibility only: enabled links use the default shared shell, never full prefetch.
const prefetchByItemId: Partial<Record<ShellSectionKey, boolean>> = {
  todos: true,
  processes: true,
  executions: true,
  settings: false,
  authorization: false,
}

export function AppSidebar({
  orgIdentity,
  version,
  showSettings,
  showAuthorization,
}: AppSidebarProps) {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { closeMobileSidebar } = useSidebar()
  const displayName =
    orgIdentity?.acronym ?? orgIdentity?.name ?? "Process Focus"
  const shouldPrefetchLinks = shouldPrefetchShellLinks(pathname)

  const handleLogout = () => performClientLogout()

  // Filter menu items based on permissions
  const visibleItems = items.filter((item) => {
    if (item.id === "settings") return showSettings
    if (item.id === "authorization") return showAuthorization
    return true
  })

  return (
    <Sidebar variant="sidebar">
      <SidebarHeader>
        <Link href="/" onClick={closeMobileSidebar} prefetch={false}>
          <div className="mb-8 flex items-start gap-3 text-slate-900 dark:text-white">
            <span className="inline-flex h-10 w-13 items-center justify-center rounded-xl bg-blue-600 font-semibold text-white mt-2">
              PF
            </span>
            <div>
              <p className="text-lg font-semibold" data-testid="org-name">
                {displayName}
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Business process control center v{version}
              </p>
            </div>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent className="">
        <SidebarGroup>
          <SidebarGroupContent className="mb-8 text-slate-900">
            <nav className="space-y-1">
              {visibleItems.map((item) => {
                const isActive =
                  pathname === item.url ||
                  (item.id === "executions" && isExecutionsPath(pathname)) ||
                  (item.id === "authorization" &&
                    pathname.startsWith("/settings/cedar/"))
                const Icon = item.icon
                const section = {
                  id: item.id,
                  label: item.title,
                  description: item.description,
                }

                return (
                  <Link
                    key={item.title}
                    href={item.url}
                    onClick={closeMobileSidebar}
                    prefetch={
                      item.id === "authorization" ||
                      (shouldPrefetchLinks &&
                        !isMobile &&
                        prefetchByItemId[item.id] !== false)
                        ? null
                        : false
                    }
                    className={cn(
                      "block w-full rounded-xl border px-4 py-3 text-left transition",
                      isActive
                        ? "border-blue-500 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
                        : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-100/70 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800/60",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {Icon && (
                          <Icon
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">
                            {getShellSectionLabel(section, isMobile)}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {getShellSectionDescription(section, isMobile)}
                          </p>
                        </div>
                      </div>
                      {item.id === "todos" && <TodoCountBadge />}
                    </div>
                  </Link>
                )
              })}
              <SidebarLists />
              <SidebarStatsViews />
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter className="mb-8">
        <div className="border-t border-slate-200 p-4 dark:border-slate-700">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={handleLogout}
            data-testid="sidebar-logout-button"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
