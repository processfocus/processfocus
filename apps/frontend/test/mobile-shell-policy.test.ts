import { describe, expect, test } from "vitest"
import {
  type ShellNavigationItem,
  getShellPolicy,
  getShellSectionDescription,
  getShellSectionLabel,
  shouldPrefetchShellLinks,
} from "../lib/mobile-shell-policy"

const dashboardSection: ShellNavigationItem = {
  id: "dashboard",
  label: "Dashboard",
  description: "Summary metrics and SLA insights",
}

const processesSection: ShellNavigationItem = {
  id: "processes",
  label: "Processes",
  description: "Browse and start business processes",
}

describe("mobile shell policy", () => {
  test("renames the dashboard section to Home on mobile", () => {
    expect(getShellSectionLabel(dashboardSection, true)).toBe("Home")
  })

  test("updates the dashboard description for mobile home", () => {
    expect(getShellSectionDescription(dashboardSection, true)).toBe(
      "My to-dos and quick actions",
    )
  })

  test("keeps desktop dashboard labeling unchanged", () => {
    expect(getShellSectionLabel(dashboardSection, false)).toBe("Dashboard")
  })

  test("keeps desktop dashboard description unchanged", () => {
    expect(getShellSectionDescription(dashboardSection, false)).toBe(
      "Summary metrics and SLA insights",
    )
  })

  test("falls back to default copy when section is undefined", () => {
    expect(getShellSectionDescription(undefined, false)).toBe(
      "Operate with clarity",
    )
  })

  test("returns a compact mobile header policy", () => {
    const policy = getShellPolicy({ isMobile: true, section: dashboardSection })

    expect(policy.header).toEqual({
      title: "Home",
      subtitle: null,
      showWorkspaceLabel: false,
      showThemeToggle: false,
      showProfileDetails: false,
      showRealtimeStatus: false,
      showMocksToggle: false,
      showGlobalSearch: false,
      compact: true,
      showThemeMenu: true,
    })
  })

  test("preserves desktop shell behavior", () => {
    const policy = getShellPolicy({
      isMobile: false,
      section: processesSection,
    })

    expect(policy.header).toEqual({
      title: "Processes",
      subtitle: "Browse and start business processes",
      showWorkspaceLabel: true,
      showThemeToggle: true,
      showProfileDetails: true,
      showRealtimeStatus: true,
      showMocksToggle: true,
      showGlobalSearch: true,
      compact: false,
      showThemeMenu: false,
    })
  })

  test("uses a sensible fallback when no section is active", () => {
    const policy = getShellPolicy({ isMobile: true, section: undefined })

    expect(policy.header.title).toBe("Process Focus")
    expect(policy.header.subtitle).toBeNull()
  })

  test("prefetches shell links on main shell pages", () => {
    expect(shouldPrefetchShellLinks("/")).toBe(true)
    expect(shouldPrefetchShellLinks("/to-dos")).toBe(true)
    expect(shouldPrefetchShellLinks("/processes")).toBe(true)
    expect(shouldPrefetchShellLinks("/settings/cedar")).toBe(true)
  })

  test("does not prefetch shell links on nested modal or detail routes", () => {
    expect(
      shouldPrefetchShellLinks(
        "/to-dos/complete/enrolment-enquiry/Contact parent",
      ),
    ).toBe(false)
    expect(shouldPrefetchShellLinks("/processes/start/hr/onboarding")).toBe(
      false,
    )
    expect(shouldPrefetchShellLinks("/executions/execution-123")).toBe(false)
    expect(shouldPrefetchShellLinks("/lists/pre-enrolments")).toBe(false)
    expect(shouldPrefetchShellLinks("/lists/item/123")).toBe(false)
  })
})
