export type ShellSectionKey =
  | "dashboard"
  | "todos"
  | "processes"
  | "executions"
  | "orgchart"
  | "settings"
  | "authorization"

export interface ShellNavigationItem {
  id: ShellSectionKey
  label: string
  description: string
}

interface ShellPolicyInput {
  isMobile: boolean
  section: ShellNavigationItem | undefined
}

interface ShellHeaderPolicy {
  title: string
  subtitle: string | null
  showWorkspaceLabel: boolean
  showThemeToggle: boolean
  showProfileDetails: boolean
  showRealtimeStatus: boolean
  showMocksToggle: boolean
  showGlobalSearch: boolean
  compact: boolean
  showThemeMenu: boolean
}

interface ShellPolicy {
  header: ShellHeaderPolicy
}

export function getShellSectionLabel(
  section: ShellNavigationItem | undefined,
  isMobile: boolean,
): string {
  if (!section) {
    return "Process Focus"
  }

  if (isMobile && section.id === "dashboard") {
    return "Home"
  }

  return section.label
}

export function getShellSectionDescription(
  section: Pick<ShellNavigationItem, "id" | "description"> | undefined,
  isMobile: boolean,
): string {
  if (!section) {
    return "Operate with clarity"
  }

  if (isMobile && section.id === "dashboard") {
    return "My to-dos and quick actions"
  }

  return section.description
}

export function isExecutionsPath(pathname: string): boolean {
  return pathname === "/executions" || pathname.startsWith("/executions/")
}

export function shouldPrefetchShellLinks(pathname: string): boolean {
  // Keep in sync with top-level routes in AppSidebar items.
  // New overview routes must be added here to retain prefetching.
  return (
    pathname === "/" ||
    pathname === "/to-dos" ||
    pathname === "/processes" ||
    pathname === "/executions" ||
    pathname === "/org-chart" ||
    pathname === "/settings" ||
    pathname === "/settings/cedar"
  )
}

export function getShellPolicy({
  isMobile,
  section,
}: ShellPolicyInput): ShellPolicy {
  const title = getShellSectionLabel(section, isMobile)
  const subtitle = getShellSectionDescription(section, isMobile)

  if (isMobile) {
    return {
      header: {
        title,
        subtitle: null,
        showWorkspaceLabel: false,
        showThemeToggle: false,
        showProfileDetails: false,
        showRealtimeStatus: false,
        showMocksToggle: false,
        showGlobalSearch: false,
        compact: true,
        showThemeMenu: true,
      },
    }
  }

  return {
    header: {
      title,
      subtitle,
      showWorkspaceLabel: true,
      showThemeToggle: true,
      showProfileDetails: true,
      showRealtimeStatus: true,
      showMocksToggle: true,
      showGlobalSearch: true,
      compact: false,
      showThemeMenu: false,
    },
  }
}
