"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"
import type { Session } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { disconnectAllAdapters } from "@/lib/appsync-events/reconnect-registry"
import { REFRESH_BUFFER_SECONDS } from "@/lib/auth/config"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"
import { beginReplicationCredentialRefresh } from "@/lib/collections/replication-registry"

/** Minimum delay between refresh attempts to avoid rapid retries */
const MIN_REFRESH_DELAY_MS = 5_000 // 5 seconds

/** Maximum number of retries on network failure */
const MAX_RETRY_COUNT = 3

/** Base delay for exponential backoff (doubles each retry) */
const RETRY_BASE_DELAY_MS = 1_000 // 1 second

interface TokenRefreshSchedulerProps {
  /** Unix timestamp in seconds when the access token expires */
  initialExpiresAt: number
  session: Session
  onRefresh: (expiresAt: number) => Promise<void>
  onInvalidSession: () => void
}

/**
 * Client component that schedules JWT token refresh before expiry.
 *
 * - Schedules refresh 5 minutes before token expires
 * - Calls POST /api/auth/refresh which uses httpOnly cookies
 * - Handles tab visibility: pauses when hidden, refreshes immediately when visible if needed
 * - Retries on network failure with exponential backoff
 * - Redirects to /login on auth failure
 */
export function TokenRefreshScheduler({
  initialExpiresAt,
  session,
  onRefresh,
  onInvalidSession,
}: TokenRefreshSchedulerProps) {
  const router = useRouter()
  const expiresAtRef = useRef(initialExpiresAt)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCountRef = useRef(0)
  const cancelRefreshRef = useRef<(() => void) | null>(null)
  const isMountedRef = useRef(true)
  const hasRedirectedRef = useRef(false)
  const scheduleRefreshRef = useRef<() => void>(() => undefined)

  const clearScheduledRefresh = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const redirectToLogin = useCallback(() => {
    if (hasRedirectedRef.current) return
    hasRedirectedRef.current = true
    clearScheduledRefresh()
    disconnectAllAdapters()
    onInvalidSession()
    router.push("/login")
  }, [clearScheduledRefresh, router, onInvalidSession])

  const refreshToken = useCallback(async (): Promise<boolean | null> => {
    // Prevent overlapping refresh attempts
    if (cancelRefreshRef.current) {
      return true // Treat as success since a refresh is already in progress
    }

    const settle = beginReplicationCredentialRefresh(
      getSessionCacheScope(session),
    )
    let cancelled = false
    const cancel = () => {
      cancelled = true
      settle()
    }
    cancelRefreshRef.current = cancel
    let success: boolean
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      })
      if (cancelled) return null

      if (!response.ok) {
        // Server error - might be temporary, allow retry
        success = false
      } else {
        const data: unknown = await response.json()
        if (cancelled) return null

        if (
          typeof data !== "object" ||
          data === null ||
          !("success" in data) ||
          data.success !== true
        ) {
          // Auth failure - redirect to login
          redirectToLogin()
          success = true // Don't retry, we're redirecting
        } else {
          const unchanged =
            "expiresAt" in data &&
            typeof data.expiresAt === "number" &&
            Number.isSafeInteger(data.expiresAt) &&
            data.expiresAt > Date.now() / 1000 &&
            "cacheScope" in data &&
            data.cacheScope === getSessionCacheScope(session) &&
            "recipientId" in data &&
            typeof data.recipientId === "string" &&
            data.recipientId ===
              (await getRealtimeRecipientId(session, data.expiresAt))
          if (cancelled) return null
          if (
            unchanged &&
            "expiresAt" in data &&
            typeof data.expiresAt === "number"
          ) {
            try {
              await onRefresh(data.expiresAt)
              if (cancelled) return null
              expiresAtRef.current = data.expiresAt
              retryCountRef.current = 0
              success = true
            } catch {
              if (cancelled) return null
              disconnectAllAdapters()
              onInvalidSession()
              hasRedirectedRef.current = true
              clearScheduledRefresh()
              window.location.reload()
              return true
            }
          } else {
            disconnectAllAdapters()
            onInvalidSession()
            hasRedirectedRef.current = true
            clearScheduledRefresh()
            window.location.reload()
            return true
          }
        }
      }
    } catch {
      if (cancelled) return null
      // Network error - allow retry
      success = false
    } finally {
      settle()
      if (cancelRefreshRef.current === cancel) cancelRefreshRef.current = null
    }
    return success
  }, [
    redirectToLogin,
    session,
    onRefresh,
    onInvalidSession,
    clearScheduledRefresh,
  ])

  const scheduleRefresh = useCallback(() => {
    // Stop scheduling if we've already redirected to login
    if (hasRedirectedRef.current) return

    clearScheduledRefresh()

    const nowSeconds = Math.floor(Date.now() / 1000)
    const expiresAt = expiresAtRef.current
    const timeUntilExpirySeconds = expiresAt - nowSeconds
    const timeUntilRefreshSeconds =
      timeUntilExpirySeconds - REFRESH_BUFFER_SECONDS

    // Calculate delay in milliseconds
    let delayMs = timeUntilRefreshSeconds * 1000

    // Ensure minimum delay to avoid rapid retries
    if (delayMs < MIN_REFRESH_DELAY_MS) {
      delayMs = MIN_REFRESH_DELAY_MS
    }

    // If already expired or about to expire, refresh immediately (with min delay)
    if (timeUntilExpirySeconds <= 0) {
      delayMs = MIN_REFRESH_DELAY_MS
    }

    timeoutRef.current = setTimeout(async () => {
      // Skip if we've already redirected
      if (!isMountedRef.current || hasRedirectedRef.current) return

      const success = await refreshToken()

      // Skip scheduling if we've already redirected
      if (success === null || !isMountedRef.current || hasRedirectedRef.current)
        return

      if (success) {
        // Schedule next refresh
        scheduleRefreshRef.current()
      } else {
        // Retry with exponential backoff
        retryCountRef.current += 1

        if (retryCountRef.current > MAX_RETRY_COUNT) {
          // Max retries exceeded - redirect to login
          redirectToLogin()
        } else {
          // Exponential backoff: 1s, 2s, 4s
          const backoffDelay =
            RETRY_BASE_DELAY_MS * 2 ** (retryCountRef.current - 1)

          timeoutRef.current = setTimeout(() => {
            if (hasRedirectedRef.current) return
            scheduleRefreshRef.current()
          }, backoffDelay)
        }
      }
    }, delayMs)
  }, [clearScheduledRefresh, refreshToken, redirectToLogin])

  useEffect(() => {
    isMountedRef.current = true
    expiresAtRef.current = initialExpiresAt
    scheduleRefreshRef.current = scheduleRefresh
  }, [scheduleRefresh, initialExpiresAt])

  // Handle visibility changes
  const handleVisibilityChange = useCallback(() => {
    // Skip if we've already redirected to login
    if (hasRedirectedRef.current) return

    if (document.visibilityState === "visible") {
      // Tab became visible - check if we need to refresh
      const nowSeconds = Math.floor(Date.now() / 1000)
      const expiresAt = expiresAtRef.current
      const timeUntilExpirySeconds = expiresAt - nowSeconds

      if (timeUntilExpirySeconds <= REFRESH_BUFFER_SECONDS) {
        // Token expired or expiring soon - refresh immediately
        clearScheduledRefresh()
        // Reset retry count - visibility change is a fresh user interaction
        retryCountRef.current = 0
        void refreshToken().then((success) => {
          if (
            success === null ||
            !isMountedRef.current ||
            hasRedirectedRef.current
          )
            return

          if (success) {
            clearScheduledRefresh()
            scheduleRefresh()
          } else {
            // Apply same retry logic as scheduled refreshes
            retryCountRef.current += 1
            if (retryCountRef.current > MAX_RETRY_COUNT) {
              redirectToLogin()
            } else {
              const backoffDelay =
                RETRY_BASE_DELAY_MS * 2 ** (retryCountRef.current - 1)
              timeoutRef.current = setTimeout(() => {
                if (hasRedirectedRef.current) return
                scheduleRefresh()
              }, backoffDelay)
            }
          }
        })
      } else {
        // Token still valid - reschedule
        scheduleRefresh()
      }
    } else {
      // Tab became hidden - pause refresh
      clearScheduledRefresh()
    }
  }, [clearScheduledRefresh, redirectToLogin, refreshToken, scheduleRefresh])

  useEffect(() => {
    isMountedRef.current = true
    // Initial schedule
    scheduleRefresh()

    // Listen for visibility changes
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      isMountedRef.current = false
      cancelRefreshRef.current?.()
      cancelRefreshRef.current = null
      clearScheduledRefresh()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [scheduleRefresh, handleVisibilityChange, clearScheduledRefresh])

  // This component doesn't render anything
  return null
}
