export const AUTHORIZATION_TABS = [
  { id: "access", label: "Access" },
  { id: "explorer", label: "Explorer" },
  { id: "policies", label: "Policies" },
  { id: "schema", label: "Schema" },
] as const

export type AuthorizationTabId = (typeof AUTHORIZATION_TABS)[number]["id"]

export const parseAuthorizationTab = (
  segment: string | undefined,
): AuthorizationTabId | null => {
  if (segment === undefined) return "access"
  const match = AUTHORIZATION_TABS.find((tab) => tab.id === segment)
  return match?.id ?? null
}

export const authorizationTabHref = (tab: AuthorizationTabId): string =>
  `/settings/cedar/${tab}`
