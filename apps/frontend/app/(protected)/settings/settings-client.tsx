"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { InvitationsTable } from "./invitations-table"
import { ProvidersTable } from "./providers-table"
import { RolesTable } from "./roles-table"
import { UsersTable } from "./users-table"
import { TabPill } from "@/components/ui/tab-pill"
import type { InvitationLifecycleStatus } from "@/lib/generated/gql/graphql"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAllInvitations,
  fetchAllOAuthProviders,
  fetchAllSettingsRoles,
  fetchAllUsers,
  fetchSettingsCounts,
} from "@/lib/graphql/settings-queries"

export type SettingsSection = "users" | "providers" | "invitations" | "roles"

const LIMIT = 20

interface SettingsClientProps {
  activeTab: SettingsSection
  canAdministerUsers: boolean
  canAdministerOAuthProviders: boolean
}

const sections = [
  { tab: "users", label: "Users" },
  { tab: "invitations", label: "Invited Users" },
  { tab: "roles", label: "Roles" },
  { tab: "providers", label: "Authentication Providers" },
] satisfies { tab: SettingsSection; label: string }[]

export function SettingsClient({
  activeTab,
  canAdministerUsers,
  canAdministerOAuthProviders,
}: SettingsClientProps) {
  const client = useGraphqlClient()
  const [page, setPage] = useState(1)
  const [invitationStatus, setInvitationStatus] =
    useState<InvitationLifecycleStatus>("PENDING")
  const status = activeTab === "invitations" ? invitationStatus : undefined
  const canOpen = (tab: SettingsSection) =>
    tab === "providers" ? canAdministerOAuthProviders : canAdministerUsers

  const rows = useQuery({
    queryKey: ["settings", "rows", activeTab, page, status],
    enabled: canOpen(activeTab),
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      switch (activeTab) {
        case "users":
          return {
            tab: activeTab,
            data: await fetchAllUsers(client, page, LIMIT),
          }
        case "invitations":
          return {
            tab: activeTab,
            data: await fetchAllInvitations(client, page, LIMIT, status),
          }
        case "roles":
          return {
            tab: activeTab,
            data: await fetchAllSettingsRoles(client, page, LIMIT),
          }
        case "providers":
          return {
            tab: activeTab,
            data: await fetchAllOAuthProviders(client, page, LIMIT),
          }
      }
    },
  })

  const inactive = {
    users: canAdministerUsers && activeTab !== "users",
    invitations: canAdministerUsers && activeTab !== "invitations",
    roles: canAdministerUsers && activeTab !== "roles",
    providers: canAdministerOAuthProviders && activeTab !== "providers",
  }
  const counts = useQuery({
    queryKey: ["settings", "counts", inactive],
    enabled: Object.values(inactive).some(Boolean),
    staleTime: 0,
    retry: false,
    queryFn: () => fetchSettingsCounts(client, inactive),
  })

  const badgeCounts = {
    users: counts.data?.settingsUserCount,
    invitations: counts.data?.settingsInvitationCount,
    roles: counts.data?.settingsRoleCount,
    providers: counts.data?.settingsOAuthProviderCount,
    [activeTab]: rows.data?.data.totalCount,
  }

  const handleInvitationStatusChange = (
    nextStatus: InvitationLifecycleStatus,
  ) => {
    setInvitationStatus(nextStatus)
    setPage(1)
  }

  const section = rows.data
  const rowsLoading = rows.isPending || rows.fetchStatus !== "idle"
  const errorMessage =
    rows.error?.message ??
    (counts.error ? "Could not load settings section counts." : null)

  return (
    <div className="space-y-6">
      <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
        {sections
          .filter(({ tab }) => canOpen(tab))
          .map(({ tab, label }) => {
            const active = activeTab === tab
            const countUnavailable = active
              ? rows.isError || rowsLoading
              : counts.isError || counts.fetchStatus !== "idle"
            const count = countUnavailable ? undefined : badgeCounts[tab]
            return (
              <TabPill
                key={tab}
                label={label}
                {...(count === undefined ? {} : { count })}
                active={active}
                href={`/settings/${tab}`}
              />
            )
          })}
      </nav>

      {canOpen(activeTab) && errorMessage !== null ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{errorMessage}</p>
        </div>
      ) : null}

      {!canOpen(activeTab) || rows.error ? null : rowsLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
        </div>
      ) : section?.tab === "users" ? (
        <UsersTable data={section.data} onPageChange={setPage} />
      ) : section?.tab === "invitations" ? (
        <InvitationsTable
          data={section.data}
          status={invitationStatus}
          onPageChange={setPage}
          onStatusChange={handleInvitationStatusChange}
        />
      ) : section?.tab === "roles" ? (
        <RolesTable data={section.data} onPageChange={setPage} />
      ) : section?.tab === "providers" ? (
        <ProvidersTable data={section.data} onPageChange={setPage} />
      ) : null}
    </div>
  )
}
