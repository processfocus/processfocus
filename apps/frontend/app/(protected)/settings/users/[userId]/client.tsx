"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Button } from "@pf/shadcn-components"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAllRoles,
  fetchUserDetail,
  saveProviderUser,
} from "@/lib/graphql/user-queries"

interface UserEditClientProps {
  userId: string
}

export function UserEditClient({ userId }: UserEditClientProps) {
  const router = useRouter()
  const client = useGraphqlClient()
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([])
  const [taskAssignmentEmail, setTaskAssignmentEmail] = useState(false)
  const [executionFailureEmail, setExecutionFailureEmail] = useState(false)
  const [formInitialized, setFormInitialized] = useState(false)

  // Fetch user detail
  const {
    data: userDetail,
    isLoading: userLoading,
    error: userError,
  } = useQuery({
    queryKey: ["userDetail", userId],
    queryFn: () => fetchUserDetail(client, userId),
  })

  // Fetch all roles
  const {
    data: roles = [],
    isLoading: rolesLoading,
    error: rolesError,
  } = useQuery({
    queryKey: ["allRoles"],
    queryFn: () => fetchAllRoles(client),
  })

  const loading = userLoading || rolesLoading
  const queryError = userError || rolesError

  // Initialize form state when user data loads (only once)
  useEffect(() => {
    if (userDetail?.providerUser && !formInitialized) {
      setSelectedRoleIds(userDetail.providerUser.roleIds as string[])
      // Initialize notification preferences (default to false if not set)
      const notificationPrefs = userDetail.providerUser.notificationPreferences
      const emailEnabled =
        notificationPrefs?.notifications?.todoAssignment?.email ?? false
      const executionFailureEnabled =
        notificationPrefs?.notifications?.executionFailure?.email ?? false
      setTaskAssignmentEmail(emailEnabled)
      setExecutionFailureEmail(executionFailureEnabled)
      setFormInitialized(true)
    }
  }, [userDetail, formInitialized])

  const handleRoleToggle = (roleId: string) => {
    setSelectedRoleIds((prev) =>
      prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId],
    )
  }

  const handleSave = async () => {
    if (!userDetail?.providerUser) return

    try {
      setSaving(true)
      setError(null)

      const result = await saveProviderUser(
        client,
        userDetail.providerUser.id,
        userId,
        selectedRoleIds,
        taskAssignmentEmail,
        executionFailureEmail,
      )

      // Collect errors from either mutation
      const errors: string[] = []

      if (result.providerUser.__typename === "UpdateProviderUserFailure") {
        errors.push(result.providerUser.error)
      }

      if (
        result.notificationPreferences.__typename ===
        "UpdateNotificationPreferencesFailure"
      ) {
        errors.push(result.notificationPreferences.error)
      }

      if (errors.length > 0) {
        setError(errors.join("; "))
      } else {
        // Both succeeded
        await queryClient.invalidateQueries({
          queryKey: ["userDetail", userId],
        })
        router.push("/settings")
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update user"
      setError(message)
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
      </div>
    )
  }

  if (queryError) {
    const message =
      queryError instanceof Error
        ? queryError.message
        : "Failed to load user data"
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
        <p className="font-medium">Error</p>
        <p className="text-sm">{message}</p>
      </div>
    )
  }

  if (!userDetail) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
        <p className="font-medium">User not found</p>
      </div>
    )
  }

  if (!userDetail.providerUser) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-700">
        <p className="font-medium">Not a provider user</p>
        <p className="text-sm">
          This user does not have a provider user record and cannot be edited.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Edit Provider User</h1>
      <Link
        className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
        href={`/settings/users/${encodeURIComponent(userId)}/tokens`}
      >
        Manage tokens for{" "}
        {userDetail.providerUser.name || userDetail.providerUser.email}
      </Link>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Provider User Information</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Email and name come from the external identity provider and are
            read-only here.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            type="email"
            value={userDetail.providerUser.email}
            placeholder="user@example.com"
            disabled
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="firstName" className="text-sm font-medium">
              First Name
            </label>
            <Input
              id="firstName"
              type="text"
              value={userDetail.providerUser.firstName}
              placeholder="John"
              disabled
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="lastName" className="text-sm font-medium">
              Last Name
            </label>
            <Input
              id="lastName"
              type="text"
              value={userDetail.providerUser.lastName}
              placeholder="Doe"
              disabled
            />
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="fullName" className="text-sm font-medium">
            Full Name (auto-computed)
          </label>
          <Input
            id="fullName"
            type="text"
            value={userDetail.providerUser.name}
            disabled
            className="bg-slate-50"
          />
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Role Assignments</h2>

        <div className="space-y-3">
          {roles.map((role) => (
            <div key={role.id} className="flex items-center gap-3">
              <Checkbox
                id={`role-${role.id}`}
                checked={selectedRoleIds.includes(role.id)}
                onCheckedChange={() => handleRoleToggle(role.id)}
                disabled={saving}
              />
              <label
                htmlFor={`role-${role.id}`}
                className="flex cursor-pointer flex-col"
              >
                <span className="font-medium">{role.name}</span>
                <span className="text-sm text-slate-500">{role.path}</span>
              </label>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Notification Preferences</h2>

        <div className="flex items-center gap-3">
          <Checkbox
            id="taskAssignmentEmail"
            checked={taskAssignmentEmail}
            onCheckedChange={(checked) => {
              if (typeof checked === "boolean") {
                setTaskAssignmentEmail(checked)
              }
            }}
            disabled={saving}
          />
          <label
            htmlFor="taskAssignmentEmail"
            className="flex cursor-pointer flex-col"
          >
            <span className="font-medium">Task Assignment Emails</span>
            <span className="text-sm text-slate-500">
              Send email notifications when new tasks are assigned
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Checkbox
            id="executionFailureEmail"
            checked={executionFailureEmail}
            onCheckedChange={(checked) => {
              if (typeof checked === "boolean") {
                setExecutionFailureEmail(checked)
              }
            }}
            disabled={saving}
          />
          <label
            htmlFor="executionFailureEmail"
            className="flex cursor-pointer flex-col"
          >
            <span className="font-medium">Execution failures</span>
            <span className="text-sm text-slate-500">
              Send email notifications for fatal execution failures
            </span>
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  )
}
