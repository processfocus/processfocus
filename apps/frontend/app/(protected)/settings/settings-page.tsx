import { Effect } from "effect"
import { redirect } from "next/navigation"
import type { ProviderUserSession } from "@pf/auth-session"
import { SettingsClient, type SettingsSection } from "./settings-client"
import { getSessionWithToken } from "@/lib/auth/session"
import { BasePageWithAuthorization } from "@/lib/effect/runtime"
import {
  checkFeaturePermissions,
  hasAnySettingsPermission,
} from "@/lib/effect/services"

const SettingsPageContent = Effect.fn("SettingsPage")(function* ({
  section,
}: {
  section?: SettingsSection
}) {
  const sessionResult = yield* getSessionWithToken.pipe(
    Effect.catch(() => Effect.succeed(null)),
  )

  if (!sessionResult || !("email" in sessionResult)) {
    return (
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 sm:px-8 lg:px-12">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <p className="font-medium">No settings available</p>
          <p className="mt-1 text-sm">
            You do not have permission to access any settings.
          </p>
        </div>
      </div>
    )
  }

  const permissions = yield* checkFeaturePermissions(
    sessionResult as ProviderUserSession,
  )

  if (
    !hasAnySettingsPermission(permissions) ||
    (section &&
      !(section === "providers"
        ? permissions.administerOAuthProviders
        : permissions.administerUsers))
  ) {
    return (
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 sm:px-8 lg:px-12">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <p className="font-medium">No settings available</p>
          <p className="mt-1 text-sm">
            You do not have permission to access any settings.
          </p>
        </div>
      </div>
    )
  }

  if (!section) {
    return yield* Effect.sync(() =>
      redirect(
        permissions.administerUsers ? "/settings/users" : "/settings/providers",
      ),
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 sm:px-8 lg:px-12">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
          Users & Sign-in
        </h2>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          Manage users, invitations, roles, and sign-in providers.
        </p>
      </div>

      <SettingsClient
        key={section}
        activeTab={section}
        canAdministerUsers={permissions.administerUsers}
        canAdministerOAuthProviders={permissions.administerOAuthProviders}
      />
    </div>
  )
})

export const SettingsPage = BasePageWithAuthorization.build(SettingsPageContent)
