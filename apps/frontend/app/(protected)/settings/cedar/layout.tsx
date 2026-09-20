import type { ReactNode } from "react"
import { AuthorizationTabs } from "./authorization-tabs"

export default function AuthorizationLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-0 flex-col overflow-hidden md:h-[calc(100dvh-14rem)]">
      <div className="mb-6 shrink-0">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
          Authorisation
        </h2>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          Combined effective access, policies, and schema
        </p>
      </div>
      <AuthorizationTabs />
      {children}
    </div>
  )
}
