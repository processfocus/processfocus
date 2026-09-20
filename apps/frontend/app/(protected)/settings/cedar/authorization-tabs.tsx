"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useFeaturePermissions } from "@/components/feature-permissions-provider"
import {
  AUTHORIZATION_TABS,
  authorizationTabHref,
  parseAuthorizationTab,
} from "@/lib/authorization-tabs"
import { cn } from "@/lib/utils"

export function AuthorizationTabs() {
  const { viewAuthorization } = useFeaturePermissions()
  const params = useParams<{ tab?: string[] }>()
  const activeTab = parseAuthorizationTab(params.tab?.[0]) ?? "access"

  if (!viewAuthorization) return null

  return (
    <nav
      aria-label="Authorisation sections"
      className="mb-6 flex shrink-0 flex-wrap gap-2"
    >
      {AUTHORIZATION_TABS.map((tab) => {
        const active = activeTab === tab.id

        return (
          <Link
            key={tab.id}
            href={authorizationTabHref(tab.id)}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition",
              active
                ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
                : "border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
