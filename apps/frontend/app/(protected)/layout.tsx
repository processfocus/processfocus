import "../global.css"
import { redirect } from "next/navigation"
import type { ProviderUserSession } from "@pf/auth-session"
import { AppShell } from "../app-shell"
import { AuthProvider } from "@/components/auth-provider"
import { ConfigProvider } from "@/components/config-provider"
import { DashboardActivity } from "@/components/dashboard-activity"
import { FrontendClientPluginIdentify } from "@/components/frontend-client-plugin-identify"
import { SessionReissue } from "@/components/session-reissue"
import { ThemeProvider } from "@/components/theme-provider"
import { toClientSession } from "@/lib/auth/client-session"
import { matchesRealtimeSessionToken } from "@/lib/auth/realtime-session-token"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { RxDbProvider } from "@/lib/collections/rxdb-provider"
import { getCurrentProviderUser } from "@/lib/current-provider-user"
import {
  getFeaturePermissions,
  hasAnySettingsPermission,
} from "@/lib/effect/services"
import { noFeaturePermissions } from "@/lib/feature-permissions"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"
import { GraphqlClientProvider } from "@/lib/graphql/client-provider"
import { FileUploadClientProvider } from "@/lib/graphql/file-upload-provider"
import { LookupClientProvider } from "@/lib/graphql/lookup-provider"
import { getOrgIdentity } from "@/lib/org-identity"
import { FrontendPlugins } from "@/lib/plugins-client"
import { getRuntimeConfig } from "@/lib/runtime-config"

// Entering the authenticated shell must wait for the session and permissions.
// This exempts only protected routes from static-shell validation; destination
// navigation below an already mounted layout is still validated in development.
export const instant = false

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSessionWithTokenAndExpiry()

  if (!session) {
    redirect("/login")
  }
  const clientSession = toClientSession(session)
  if (
    !matchesRealtimeSessionToken(
      session.accessToken,
      clientSession,
      session.expiresAt,
    )
  ) {
    // Live delegation facts can change while the signed JWT remains valid.
    // Do not mount any authenticated caches until a matching token is issued.
    return <SessionReissue />
  }

  const isProviderUser = "email" in session

  const [orgIdentity, providerUser, featurePermissions] = await Promise.all([
    getOrgIdentity(session.accessToken),
    getCurrentProviderUser(session.accessToken),
    isProviderUser
      ? getFeaturePermissions(session as ProviderUserSession)
      : Promise.resolve(noFeaturePermissions),
  ])

  if (!orgIdentity) {
    return (
      <ThemeProvider>
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md space-y-2 rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-900/20">
            <h1 className="text-lg font-semibold text-red-900 dark:text-red-100">
              Unable to load workspace
            </h1>
            <p className="text-sm text-red-700 dark:text-red-200">
              We couldn&apos;t load the organisation details for this session.
              Refresh the page and try again.
            </p>
          </div>
        </div>
      </ThemeProvider>
    )
  }

  const config = getRuntimeConfig(orgIdentity.id)
  const frontendManifest = getFrontendManifest()
  const showSettings = hasAnySettingsPermission(featurePermissions)
  const showAuthorization = featurePermissions.viewAuthorization

  return (
    <FrontendPlugins manifest={frontendManifest}>
      <ThemeProvider>
        <AuthProvider session={clientSession} expiresAt={session.expiresAt}>
          <FrontendClientPluginIdentify
            {...("email" in clientSession
              ? { email: clientSession.email }
              : {})}
            {...(providerUser?.name ? { name: providerUser.name } : {})}
            userId={clientSession.userId}
          />
          <ConfigProvider value={config}>
            <GraphqlClientProvider>
              <DashboardActivity />
              <FileUploadClientProvider>
                <LookupClientProvider>
                  <RxDbProvider>
                    <AppShell
                      orgIdentity={orgIdentity}
                      providerUser={providerUser}
                      version={
                        process.env["NEXT_PUBLIC_PROCESS_FOCUS_VERSION"] ??
                        "unknown"
                      }
                      featurePermissions={featurePermissions}
                      showSettings={showSettings}
                      showAuthorization={showAuthorization}
                    >
                      {children}
                    </AppShell>
                  </RxDbProvider>
                </LookupClientProvider>
              </FileUploadClientProvider>
            </GraphqlClientProvider>
          </ConfigProvider>
        </AuthProvider>
      </ThemeProvider>
    </FrontendPlugins>
  )
}
