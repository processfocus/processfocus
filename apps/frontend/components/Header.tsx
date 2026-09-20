"use client"

import { useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  Copy,
  Fingerprint,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserCog,
  UserRoundKey,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useEffect, useState } from "react"
import { DelegationExpiry } from "./delegation-expiry"
import { useMocks } from "./mocks-provider"
import { NotificationBell } from "./notification-bell"
import { listDelegations } from "@/app/(protected)/act-on-behalf/actions"
import { listPasskeys } from "@/app/(protected)/passkeys/actions"
import { useSession } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"
import { useTheme } from "@/components/theme-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { canOpenActOnBehalfMenu } from "@/lib/auth/act-on-behalf-menu"
import { performClientLogout } from "@/lib/auth/logout"
import { canOpenPasskeysMenu } from "@/lib/auth/passkeys-menu"
import { useRxDb } from "@/lib/collections/rxdb-provider"
import type { CurrentProviderUser } from "@/lib/current-provider-user"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { fetchCurrentProviderUser } from "@/lib/graphql/provider-user-queries"
import {
  type ShellNavigationItem,
  getShellPolicy,
} from "@/lib/mobile-shell-policy"
import { cn } from "@/lib/utils"

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Avoid hydration mismatch
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <button
        type="button"
        className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
        aria-label="Toggle theme"
        data-testid="header-theme-toggle"
      >
        <span className="h-5 w-5" />
      </button>
    )
  }

  const cycleTheme = () => {
    const currentTheme = theme ?? "system"
    if (currentTheme === "light") {
      setTheme("dark")
    } else if (currentTheme === "dark") {
      setTheme("system")
    } else {
      setTheme("light")
    }
  }

  return (
    <button
      type="button"
      onClick={cycleTheme}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
      aria-label={`Current theme: ${theme}. Click to cycle theme.`}
      title={`Theme: ${theme}`}
      data-testid="header-theme-toggle"
    >
      {theme === "dark" ? (
        <Moon className="h-5 w-5 text-slate-500 dark:text-slate-400" />
      ) : theme === "light" ? (
        <Sun className="h-5 w-5 text-amber-500" />
      ) : (
        <Monitor className="h-5 w-5 text-slate-500 dark:text-slate-400" />
      )}
    </button>
  )
}

function ThemeMenu({
  theme,
  setTheme,
}: {
  theme: string | undefined
  setTheme: (theme: string) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sun className="mr-2 h-4 w-4" />
        <span>Theme</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={theme ?? "system"}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="mr-2 h-4 w-4" />
            <span>Light</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="mr-2 h-4 w-4" />
            <span>Dark</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="mr-2 h-4 w-4" />
            <span>System</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export const navigation: ShellNavigationItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Summary metrics and SLA insights",
  },
  {
    id: "todos",
    label: "My To-Dos",
    description: "Tasks that need your attention",
  },
  {
    id: "processes",
    label: "Processes",
    description: "Browse and start business processes",
  },
  {
    id: "executions",
    label: "Executions",
    description: "Monitor live and historical instances",
  },
  {
    id: "orgchart",
    label: "Org Chart",
    description: "View organization structure and roles",
  },
  {
    id: "settings",
    label: "Profile & Settings",
    description: "Preferences, notifications, and roles",
  },
  {
    id: "authorization",
    label: "Authorisation",
    description: "Policies, schema, and access",
  },
]

/**
 * Get initials from first and last name
 */
function getInitials(firstName: string, lastName: string): string {
  const first = firstName.trim()[0]?.toUpperCase() ?? ""
  const last = lastName.trim()[0]?.toUpperCase() ?? ""
  return first + last
}

export function Header({
  section,
  initialProviderUser,
}: {
  section: ShellNavigationItem | undefined
  initialProviderUser: CurrentProviderUser | null
}) {
  const graphqlClient = useGraphqlClient()
  const { resetForRoleSwitch } = useRxDb()
  const isMobile = useIsMobile()
  const shellPolicy = getShellPolicy({ isMobile, section })
  const session = useSession()
  const runtimeConfig = useRuntimeConfig()
  const [isSwitchingRole, setIsSwitchingRole] = useState(false)
  const { showMocks, setShowMocks } = useMocks()
  const { theme, setTheme } = useTheme()

  // Query key uses endpoint string (stable) rather than client object (recreated each render)
  const { data: delegationListing } = useQuery({
    queryKey: [
      "delegationListing",
      runtimeConfig.graphqlEndpoint,
      "email" in session ? session.email : session.clientId,
    ],
    queryFn: () => listDelegations(),
    retry: false,
  })
  const { data: passkeyListing } = useQuery({
    queryKey: [
      "passkeyListing",
      runtimeConfig.graphqlEndpoint,
      "email" in session ? session.email : session.clientId,
    ],
    queryFn: () => listPasskeys(),
    retry: false,
    enabled: "email" in session,
  })

  // to prevent unnecessary re-fetches during hydration
  const { data: providerUser } = useQuery({
    queryKey: ["currentProviderUser", runtimeConfig.graphqlEndpoint],
    queryFn: () => fetchCurrentProviderUser(graphqlClient),
    initialData: initialProviderUser ?? undefined,
    retry: false,
  })

  // Calculate initials from firstName and lastName
  const initials = providerUser
    ? getInitials(providerUser.firstName, providerUser.lastName)
    : "?"

  // Use provider user data or fallback to default
  const displayName = providerUser?.name ?? "Loading..."
  const delegation = "email" in session ? session.delegation : undefined
  const providerEmail = "email" in session ? session.email : providerUser?.email
  const profileName = delegation?.name ?? displayName
  const permittedRoles = providerUser?.permittedRoles ?? []
  // Get current role from session JWT (first role in the array)
  const currentRole = session.roles?.[0]
  // Provider user sessions are discriminated by email; service sessions carry clientId.
  const isProviderUser = "email" in session
  const orgId = runtimeConfig.orgId

  const handleLogout = () => performClientLogout()

  const handleSwitchRole = async (rolePath: string) => {
    if (isSwitchingRole || !rolePath) return

    setIsSwitchingRole(true)
    try {
      const response = await fetch("/api/auth/switch-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rolePath }),
      })

      const result = await response.json()

      if (result.success) {
        await resetForRoleSwitch()
      } else {
        console.error("Failed to switch role:", result.error)
      }
    } catch (error) {
      console.error("Failed to switch role:", error)
    }
    setIsSwitchingRole(false)
  }

  return (
    <header
      className={cn(
        "flex items-center justify-between border-b border-slate-200 bg-white/80 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/60",
        shellPolicy.header.compact
          ? "h-16 px-4 sm:px-6"
          : "h-20 px-6 sm:px-8 lg:px-12",
      )}
      data-testid="app-header"
    >
      <div className="flex min-w-0 items-center gap-3 lg:gap-6">
        <SidebarTrigger
          className={shellPolicy.header.compact ? "-ml-1" : "-ml-9"}
        />
        <div>
          {shellPolicy.header.showWorkspaceLabel && (
            <p className="text-sm font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
              Workspace
            </p>
          )}
          <h1
            className="text-xl font-semibold text-slate-900 dark:text-slate-50"
            data-testid="header-title"
          >
            {shellPolicy.header.title}
          </h1>
          {shellPolicy.header.subtitle && (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="header-subtitle"
            >
              {shellPolicy.header.subtitle}
            </p>
          )}
        </div>
        {shellPolicy.header.showRealtimeStatus && (
          <div className="hidden items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-500 shadow-sm lg:flex dark:border-slate-700 dark:text-slate-400">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Real time sync active
          </div>
        )}
        {shellPolicy.header.showMocksToggle && (
          <button
            type="button"
            onClick={() => setShowMocks(!showMocks)}
            className="hidden items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-500 shadow-sm transition-colors hover:bg-slate-50 lg:flex dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <span
              className={`h-2 w-2 rounded-full ${showMocks ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}
            />
            Mocks
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        {shellPolicy.header.showGlobalSearch && (
          <div className="hidden items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 shadow-sm md:flex dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            <span className="text-slate-400 dark:text-slate-500">⌘K</span>
            Global search
          </div>
        )}
        {shellPolicy.header.showThemeToggle && <ThemeToggle />}
        {isProviderUser && (
          <NotificationBell userId={session.userId} orgId={orgId} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-w-0 cursor-pointer items-center rounded-full border border-slate-200 bg-white shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800",
                shellPolicy.header.showProfileDetails
                  ? "gap-3 px-3 py-2"
                  : "gap-2 px-2 py-2",
              )}
              aria-label={
                delegation
                  ? `${delegation.name}, acting on behalf of ${providerEmail}, ${currentRole ?? "No role"}. Profile menu`
                  : undefined
              }
              data-testid="header-profile-button"
            >
              {providerUser?.picture ? (
                <Image
                  src={providerUser.picture}
                  alt={delegation ? "" : displayName}
                  width={40}
                  height={40}
                  className="h-10 w-10 shrink-0 rounded-full"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                  {initials}
                </div>
              )}
              {(shellPolicy.header.showProfileDetails || delegation) && (
                <div className="min-w-0 max-w-24 text-left sm:max-w-48 lg:max-w-64">
                  <p
                    title={profileName}
                    className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {profileName}
                  </p>
                  <p
                    title={currentRole}
                    className="truncate text-xs text-slate-500 dark:text-slate-400"
                  >
                    {currentRole ?? "No role"}
                  </p>
                </div>
              )}
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-max min-w-56 max-w-[calc(100vw-2rem)]"
          >
            {providerEmail && (
              <>
                {delegation && (
                  <DropdownMenuLabel className="max-w-80 space-y-1 [overflow-wrap:anywhere]">
                    <p>{delegation.name}</p>
                    <p className="text-xs font-normal text-muted-foreground">
                      Acting on behalf of
                    </p>
                  </DropdownMenuLabel>
                )}
                <DropdownMenuItem
                  aria-label={`Copy email address: ${providerEmail}`}
                  onSelect={(event) => {
                    event.preventDefault()
                    void navigator.clipboard.writeText(providerEmail)
                  }}
                  className="max-w-80 items-start"
                >
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {providerEmail}
                  </span>
                  <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
                </DropdownMenuItem>
                {delegation && (
                  <div className="max-w-80 px-2 py-2 text-xs text-muted-foreground">
                    <DelegationExpiry expiresAt={delegation.expiresAt} />
                  </div>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            {shellPolicy.header.showThemeMenu && (
              <ThemeMenu theme={theme} setTheme={setTheme} />
            )}
            {permittedRoles.length > 0 && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={isSwitchingRole}>
                    <UserCog className="mr-2 h-4 w-4" />
                    <span>Switch Role</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {permittedRoles.map((role) => (
                      <DropdownMenuItem
                        key={role.id}
                        onClick={() => handleSwitchRole(role.path)}
                        disabled={isSwitchingRole}
                      >
                        {role.path}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            )}
            {canOpenPasskeysMenu(passkeyListing) ? (
              <DropdownMenuItem asChild>
                <Link href="/passkeys" data-testid="header-passkeys-link">
                  <Fingerprint className="mr-2 h-4 w-4" aria-hidden="true" />
                  <span>Passkeys</span>
                </Link>
              </DropdownMenuItem>
            ) : null}
            {canOpenActOnBehalfMenu(delegationListing) ? (
              <DropdownMenuItem asChild>
                <Link href="/act-on-behalf">
                  <UserRoundKey className="mr-2 h-4 w-4" aria-hidden="true" />
                  <span>Act on behalf</span>
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={handleLogout}
              data-testid="header-logout-button"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
