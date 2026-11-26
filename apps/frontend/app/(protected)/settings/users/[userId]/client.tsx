"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Schema } from "effect"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import { Button } from "@pf/shadcn-components"
import { providerUserForm } from "@/lib/forms/provider-user"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  fetchAllRoles,
  fetchUserDetail,
  saveProviderUser,
} from "@/lib/graphql/user-queries"

export function UserEditClient({ userId }: { userId: string }) {
  const router = useRouter()
  const client = useGraphqlClient()
  const queryClient = useQueryClient()
  const [formReady, setFormReady] = useState(false)
  const {
    data: userDetail,
    isLoading: userLoading,
    error: userError,
    refetch: refetchUser,
  } = useQuery({
    queryKey: ["userDetail", userId],
    queryFn: () => fetchUserDetail(client, userId),
  })
  const {
    data: roles,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useQuery({
    queryKey: ["allRoles"],
    queryFn: () => fetchAllRoles(client),
  })
  const queryError = userError || rolesError

  // Next's Activity cache retains state on navigation, but reconnects effects.
  // Reopen from current server values; ordinary background refetches keep edits.
  useEffect(() => {
    let active = true
    setFormReady(false)
    void Promise.all([refetchUser(), refetchRoles()]).then(() => {
      if (active) setFormReady(true)
    })
    return () => {
      active = false
    }
  }, [refetchUser, refetchRoles])

  if (!formReady || userLoading || rolesLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
      </div>
    )
  }
  const queryErrorBanner = queryError ? (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
      <p className="font-medium">Error</p>
      <p className="text-sm">
        {queryError instanceof Error
          ? queryError.message
          : "Failed to load user data"}
      </p>
    </div>
  ) : null
  if (queryError && (userDetail === undefined || roles === undefined)) {
    return queryErrorBanner
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

  const user = userDetail.providerUser
  const schema = providerUserForm(
    (roles ?? []).map((role) => ({
      value: role.id,
      label: role.name,
      description: role.path,
    })),
    userDetail.provider,
    userDetail.taskAssignmentEmailAvailable,
  )
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Edit User</h1>
      <Link
        className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
        href={`/settings/users/${encodeURIComponent(userId)}/tokens`}
      >
        Manage tokens for {user.name || user.email}
      </Link>
      {queryErrorBanner}
      <EffectSchemaForm
        key={userId}
        schema={schema}
        readOnlyCheckboxFields={["taskAssignmentEmail"]}
        defaultValues={{
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.name,
          roleIds: [...new Set(user.roleIds)],
          taskAssignmentEmail:
            user.notificationPreferences?.notifications?.todoAssignment
              ?.email ?? false,
          executionFailureEmail:
            user.notificationPreferences?.notifications?.executionFailure
              ?.email ?? false,
        }}
        onSubmit={async (values) => {
          try {
            const submitted = Schema.decodeUnknownSync(
              Schema.Struct({
                ...schema.fields.assignments.fields,
                ...schema.fields.notifications.fields,
                taskAssignmentEmail: Schema.optional(
                  schema.fields.notifications.fields.taskAssignmentEmail,
                ),
              }),
            )(values)
            const names =
              userDetail.provider === "passkey"
                ? Schema.decodeUnknownSync(
                    Schema.Struct({
                      firstName: Schema.optional(Schema.String),
                      lastName: Schema.optional(Schema.String),
                    }),
                  )(values)
                : undefined
            const result = await saveProviderUser(
              client,
              user.id,
              userId,
              [...submitted.roleIds],
              userDetail.taskAssignmentEmailAvailable
                ? submitted.taskAssignmentEmail
                : undefined,
              submitted.executionFailureEmail,
              names
                ? {
                    firstName: names.firstName ?? "",
                    lastName: names.lastName ?? "",
                  }
                : undefined,
            )
            const errors: { field: string; message: string }[] = []
            if (
              result.providerUser.__typename === "UpdateProviderUserFailure"
            ) {
              errors.push({
                field: "roleIds",
                message: result.providerUser.error,
              })
            }
            if (
              result.notificationPreferences.__typename ===
              "UpdateNotificationPreferencesFailure"
            ) {
              errors.push({
                field: "",
                message: result.notificationPreferences.error,
              })
            }
            if (errors.length > 0) return errors
            await queryClient.invalidateQueries({
              queryKey: ["userDetail", userId],
            })
            router.push("/settings/users")
            return undefined
          } catch (error) {
            return [
              {
                field: "",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to update user",
              },
            ]
          }
        }}
      >
        {({ formState }) => (
          <div className="flex justify-end">
            <Button type="submit" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? "Saving..." : "Save"}
            </Button>
          </div>
        )}
      </EffectSchemaForm>
    </div>
  )
}
