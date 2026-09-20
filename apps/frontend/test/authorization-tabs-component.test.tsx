import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { AuthorizationTabs } from "../app/(protected)/settings/cedar/authorization-tabs"
import { FeaturePermissionsProvider } from "../components/feature-permissions-provider"
import type { FeaturePermissions } from "../lib/feature-permissions"

vi.mock("next/navigation", () => ({
  useParams: () => ({ tab: ["policies"] }),
}))

const permissions = (viewAuthorization: boolean): FeaturePermissions => ({
  administerUsers: false,
  administerOAuthProviders: false,
  showProcessState: false,
  viewAuthorization,
})

describe("AuthorizationTabs", () => {
  test("renders link-based tabs and marks the current route", () => {
    const markup = renderToStaticMarkup(
      <FeaturePermissionsProvider value={permissions(true)}>
        <AuthorizationTabs />
      </FeaturePermissionsProvider>,
    )

    expect(markup).toContain('aria-label="Authorisation sections"')
    for (const tab of ["access", "explorer", "policies", "schema"]) {
      expect(markup).toContain(`href="/settings/cedar/${tab}"`)
    }
    expect(markup).toContain('aria-current="page"')
  })

  test("does not expose tabs without authorisation permission", () => {
    const markup = renderToStaticMarkup(
      <FeaturePermissionsProvider value={permissions(false)}>
        <AuthorizationTabs />
      </FeaturePermissionsProvider>,
    )

    expect(markup).toBe("")
  })
})
