"use client"

import { useEffect } from "react"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { dashboardActivityQuery } from "@/lib/graphql/dashboard-activity"

/** A visible authenticated Dashboard includes read-only use; background sync does not. */
export function DashboardActivity() {
  const client = useGraphqlClient()
  useEffect(() => {
    let lastSent = 0
    const report = () => {
      if (document.visibilityState !== "visible") return
      const now = Date.now()
      if (now - lastSent < 60_000) return
      lastSent = now
      void client
        .request({
          document: dashboardActivityQuery,
          requestHeaders: { "x-pf-dashboard-activity": "1" },
        })
        .catch(() => {
          /* Best-effort analytics must not interrupt Dashboard use. */
        })
    }
    report()
    const timer = window.setInterval(report, 5 * 60_000)
    document.addEventListener("visibilitychange", report)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", report)
    }
  }, [client])
  return null
}
