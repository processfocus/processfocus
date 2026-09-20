import { Effect } from "effect"
import type { ProviderUserSession } from "@pf/auth-session"
import { SettingsClient } from "./settings-client"
import { getSessionWithToken } from "@/lib/auth/session"
import { BasePageWithAuthorization } from "@/lib/effect/runtime"
import {
  checkFeaturePermissions,
  hasAnySettingsPermission,
} from "@/lib/effect/services"

const SettingsPage = Effect.fn("SettingsPage")(function* () {
  // Get session from cookies
  const sessionResult = yield* getSessionWithToken.pipe(
    Effect.catchAll(() => Effect.succeed(null)),
  )

  // If no session or not a provider user session, show no access
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

  // Check feature permissions via Cedar
  const permissions = yield* checkFeaturePermissions(
    sessionResult as ProviderUserSession,
  )

  // If no permissions, show appropriate message
  if (!hasAnySettingsPermission(permissions)) {
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

  return (
    <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 sm:px-8 lg:px-12">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
          Profile & Settings
        </h2>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          Preferences, notifications, and roles
        </p>
      </div>

      <SettingsClient
        canAdministerUsers={permissions.administerUsers}
        canAdministerOAuthProviders={permissions.administerOAuthProviders}
      />
    </div>
  )
})

export default BasePageWithAuthorization.build(SettingsPage)
