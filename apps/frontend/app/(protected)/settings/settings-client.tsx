"use client"

import { useCallback, useEffect, useState } from "react"
import { InvitationsTable } from "./invitations-table"
import { ProvidersTable } from "./providers-table"
import { RolesTable } from "./roles-table"
import { UsersTable } from "./users-table"
import { TabPill } from "@/components/ui/tab-pill"
import type {
  AllInvitationsQuery,
  AllOAuthProvidersQuery,
  AllSettingsRolesQuery,
  AllUsersQuery,
  InvitationLifecycleStatus,
} from "@/lib/generated/gql/graphql"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAllInvitations,
  fetchAllOAuthProviders,
  fetchAllSettingsData,
  fetchAllSettingsRoles,
  fetchAllUsers,
} from "@/lib/graphql/settings-queries"

type TabKey = "users" | "providers" | "invitations" | "roles"

const LIMIT = 20

interface SettingsClientProps {
  canAdministerUsers: boolean
  canAdministerOAuthProviders: boolean
}

export function SettingsClient({
  canAdministerUsers,
  canAdministerOAuthProviders,
}: SettingsClientProps) {
  const client = useGraphqlClient()

  // Determine available tabs and default to first available
  const availableTabs: TabKey[] = []
  if (canAdministerUsers) {
    availableTabs.push("users")
    availableTabs.push("invitations")
    availableTabs.push("roles")
  }
  if (canAdministerOAuthProviders) availableTabs.push("providers")

  const [activeTab, setActiveTab] = useState<TabKey>(
    availableTabs[0] ?? "users",
  )

  const [usersData, setUsersData] = useState<AllUsersQuery["allUsers"] | null>(
    null,
  )
  const [providersData, setProvidersData] = useState<
    AllOAuthProvidersQuery["allOAuthProviders"] | null
  >(null)
  const [invitationsData, setInvitationsData] = useState<
    AllInvitationsQuery["allInvitations"] | null
  >(null)
  const [invitationStatus, setInvitationStatus] =
    useState<InvitationLifecycleStatus>("PENDING")
  const [rolesData, setRolesData] = useState<
    AllSettingsRolesQuery["allRoles"] | null
  >(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadUsers = useCallback(
    async (page: number) => {
      try {
        setError(null)
        const data = await fetchAllUsers(client, page, LIMIT)
        setUsersData(data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch users"
        setError(message)
      }
    },
    [client],
  )

  const loadProviders = useCallback(
    async (page: number) => {
      try {
        setError(null)
        const data = await fetchAllOAuthProviders(client, page, LIMIT)
        setProvidersData(data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch providers"
        setError(message)
      }
    },
    [client],
  )

  const loadInvitations = useCallback(
    async (
      page: number,
      status: InvitationLifecycleStatus = invitationStatus,
    ) => {
      try {
        setError(null)
        const data = await fetchAllInvitations(client, page, LIMIT, status)
        setInvitationsData(data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch invitations"
        setError(message)
      }
    },
    [client, invitationStatus],
  )

  const loadRoles = useCallback(
    async (page: number) => {
      try {
        setError(null)
        const data = await fetchAllSettingsRoles(client, page, LIMIT)
        setRolesData(data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch roles"
        setError(message)
      }
    },
    [client],
  )

  useEffect(() => {
    const loadInitialData = async () => {
      setLoading(true)
      setError(null)
      try {
        // Fetch all settings data in a single GraphQL request
        const data = await fetchAllSettingsData(client, 1, LIMIT)
        if (canAdministerUsers) {
          setUsersData(data.allUsers)
          setInvitationsData(data.allInvitations)
          setRolesData(data.allRoles)
        }
        if (canAdministerOAuthProviders) {
          setProvidersData(data.allOAuthProviders)
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch settings data"
        setError(message)
      }
      setLoading(false)
    }
    loadInitialData()
  }, [client, canAdministerUsers, canAdministerOAuthProviders])

  const handleUsersPageChange = (page: number) => {
    loadUsers(page)
  }

  const handleProvidersPageChange = (page: number) => {
    loadProviders(page)
  }

  const handleInvitationsPageChange = (page: number) => {
    loadInvitations(page, invitationStatus)
  }

  const handleInvitationStatusChange = (status: InvitationLifecycleStatus) => {
    setInvitationStatus(status)
    loadInvitations(1, status)
  }

  const handleRolesPageChange = (page: number) => {
    loadRoles(page)
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {canAdministerUsers && (
          <TabPill
            label="Users"
            count={usersData?.totalCount ?? 0}
            active={activeTab === "users"}
            onClick={() => setActiveTab("users")}
          />
        )}
        {canAdministerUsers && (
          <TabPill
            label="Invited Users"
            count={invitationsData?.totalCount ?? 0}
            active={activeTab === "invitations"}
            onClick={() => setActiveTab("invitations")}
          />
        )}
        {canAdministerUsers && (
          <TabPill
            label="Roles"
            count={rolesData?.totalCount ?? 0}
            active={activeTab === "roles"}
            onClick={() => setActiveTab("roles")}
          />
        )}
        {canAdministerOAuthProviders && (
          <TabPill
            label="Providers"
            count={providersData?.totalCount ?? 0}
            active={activeTab === "providers"}
            onClick={() => setActiveTab("providers")}
          />
        )}
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
        </div>
      ) : activeTab === "users" && usersData ? (
        <UsersTable data={usersData} onPageChange={handleUsersPageChange} />
      ) : activeTab === "invitations" && invitationsData ? (
        <InvitationsTable
          data={invitationsData}
          status={invitationStatus}
          onPageChange={handleInvitationsPageChange}
          onStatusChange={handleInvitationStatusChange}
        />
      ) : activeTab === "roles" && rolesData ? (
        <RolesTable data={rolesData} onPageChange={handleRolesPageChange} />
      ) : activeTab === "providers" && providersData ? (
        <ProvidersTable
          data={providersData}
          onPageChange={handleProvidersPageChange}
        />
      ) : null}
    </div>
  )
}
