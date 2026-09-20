import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { RuntimeConfig } from "../lib/runtime-config"
import { expect, mock, test } from "bun:test"

const signed = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Old"],
  orgUnitId: "org",
  orgUnitPath: "/",
  delegation: {
    id: "agent",
    generationId: "one",
    name: "old-name",
    expiresAt: 2_000_000_000_000,
  },
}
const current = {
  ...signed,
  roles: ["/Current"],
  delegation: { ...signed.delegation, name: "new-name" },
}
const expiresAt = 2_000_000_000
const tokenFor = (properties: typeof signed) =>
  `header.${Buffer.from(JSON.stringify({ properties, exp: expiresAt })).toString("base64url")}.signature`
let accessToken = tokenFor(signed)
const getOrgIdentity = mock(async () => ({ id: "org" }))
function Wrapper({ children }: { children: ReactNode }) {
  return children
}

mock.module("@/lib/auth/session", () => ({
  getSessionWithTokenAndExpiry: async () => ({
    ...current,
    accessToken,
    expiresAt,
  }),
}))
mock.module("@/lib/org-identity", () => ({ getOrgIdentity }))
mock.module("@/lib/current-provider-user", () => ({
  getCurrentProviderUser: async () => null,
}))
mock.module("@/lib/effect/services", () => ({
  getFeaturePermissions: async () => ({}),
  hasAnySettingsPermission: () => false,
}))
mock.module("@/lib/frontend-manifest-store", () => ({
  getFrontendManifest: () => ({}),
}))
const runtimeConfig: RuntimeConfig = {
  graphqlEndpoint: "https://example.test/graphql",
  wsEndpoint: "",
  appSyncEventsHttpEndpoint: "",
  orgId: "org",
  featureFlags: { newDashboard: false },
}
mock.module("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => runtimeConfig,
}))
mock.module("@/components/auth-provider", () => ({ AuthProvider: Wrapper }))
mock.module("@/components/theme-provider", () => ({ ThemeProvider: Wrapper }))
mock.module("@/components/frontend-client-plugin-identify", () => ({
  FrontendClientPluginIdentify: () => null,
}))
mock.module("@/lib/graphql/file-upload-provider", () => ({
  FileUploadClientProvider: Wrapper,
}))
mock.module("@/lib/graphql/lookup-provider", () => ({
  LookupClientProvider: Wrapper,
}))
mock.module("@/lib/collections/rxdb-provider", () => ({
  RxDbProvider: Wrapper,
}))
mock.module("@/lib/plugins-client", () => ({ FrontendPlugins: Wrapper }))
mock.module("../app/app-shell", () => ({ AppShell: Wrapper }))
const { default: ProtectedLayout } = await import("../app/(protected)/layout")

test("stale signed roles/name mount only reissuance; matching reissued JWT permits the dashboard", async () => {
  const stale = renderToStaticMarkup(
    await ProtectedLayout({ children: <div>authenticated form</div> }),
  )
  expect(stale).toContain("Renewing your session")
  expect(stale).not.toContain("authenticated form")
  expect(getOrgIdentity).not.toHaveBeenCalled()
  accessToken = tokenFor(current)
  const fresh = renderToStaticMarkup(
    await ProtectedLayout({ children: <div>authenticated form</div> }),
  )
  expect(fresh).toContain("authenticated form")
  expect(fresh).not.toContain("Renewing your session")
  expect(getOrgIdentity).toHaveBeenCalledTimes(1)
})
