"use client"

import { QueryClientProvider } from "@tanstack/react-query"
import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { useSession } from "@/components/auth-provider"
import { FeaturePermissionsProvider } from "@/components/feature-permissions-provider"
import { Header, navigation } from "@/components/Header"
import { MocksProvider } from "@/components/mocks-provider"
import { OrgSettingsProvider } from "@/components/org-settings-provider"
import { SidebarProvider } from "@/components/ui/sidebar"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"
import type { CurrentProviderUser } from "@/lib/current-provider-user"
import { DevImportCompletedQueryInvalidation } from "@/lib/dev/import-completed-query-invalidation"
import type { FeaturePermissions } from "@/lib/feature-permissions"
import { isExecutionsPath } from "@/lib/mobile-shell-policy"
import { getQueryClient } from "@/lib/query-client"
import type { OrgIdentity } from "@/lib/types/org-identity"

// Keep the RxDB/TanStack DB notification runtime browser-only without making
// it an ancestor of the server-rendered application shell.
const TodoNotificationsRuntime = dynamic(
  () =>
    import("@/lib/notifications/todo-notifications-runtime").then(
      (mod) => mod.TodoNotificationsRuntime,
    ),
  { ssr: false },
)

interface AppShellProps {
  children: React.ReactNode
  orgIdentity: OrgIdentity | null
  providerUser: CurrentProviderUser | null
  version: string
  featurePermissions: FeaturePermissions
  showSettings: boolean
  showAuthorization: boolean
}

export function AppShell({
  children,
  orgIdentity,
  providerUser,
  version,
  featurePermissions,
  showSettings,
  showAuthorization,
}: AppShellProps) {
  const pathname = usePathname()
  const session = useSession()

  // Get the singleton QueryClient for browser, or a fresh one for SSR
  const queryClient = getQueryClient(getSessionCacheScope(session))

  // Map pathname to navigation section
  const currentSection = navigation.find((item) => {
    if (item.id === "dashboard") return pathname === "/"
    if (item.id === "todos") return pathname === "/to-dos"
    if (item.id === "processes") return pathname === "/processes"
    if (item.id === "executions") return isExecutionsPath(pathname)
    if (item.id === "orgchart") return pathname === "/org-chart"
    if (item.id === "settings") return pathname === "/settings"
    if (item.id === "authorization")
      return pathname.startsWith("/settings/cedar")
    return false
  })

  return (
    <QueryClientProvider client={queryClient}>
      <DevImportCompletedQueryInvalidation />
      <FeaturePermissionsProvider value={featurePermissions}>
        <OrgSettingsProvider startDayOfWeek={orgIdentity?.startDayOfWeek ?? 0}>
          <MocksProvider>
            <TodoNotificationsRuntime />
            <div className="m-0 min-h-svh peer-[:not(:empty)]:hidden md:m-12">
              <SidebarProvider>
                <AppSidebar
                  orgIdentity={orgIdentity}
                  version={version}
                  showSettings={showSettings}
                  showAuthorization={showAuthorization}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <Header
                    section={currentSection}
                    initialProviderUser={providerUser}
                  />
                  <main className="flex-1 px-4 pt-4 pb-10 sm:px-8 sm:pt-6 sm:pb-16 lg:px-12">
                    {children}
                  </main>
                </div>
              </SidebarProvider>
            </div>
          </MocksProvider>
        </OrgSettingsProvider>
      </FeaturePermissionsProvider>
    </QueryClientProvider>
  )
}
