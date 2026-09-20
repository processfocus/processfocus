"use client"

import { getAppSyncEventsRealtimeUrl as getRealtimeUrl } from "@pf/frontend-endpoints"

/**
 * Client-side AppSync Events endpoint resolution.
 * Re-exports from @pf/frontend-endpoints with browser fallback.
 */
export const getAppSyncEventsRealtimeUrl = (): string => {
  // Pass browser host for fallback when in browser context
  const browserHost =
    typeof window !== "undefined" ? window.location.host : undefined
  const url = getRealtimeUrl(browserHost)
  if (!url) {
    throw new Error("Cannot determine AppSync Events realtime URL")
  }
  return url
}
