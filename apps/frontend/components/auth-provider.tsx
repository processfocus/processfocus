"use client"

import type { ReactNode } from "react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import type { Session } from "@pf/auth-session"
import { TokenRefreshScheduler } from "./token-refresh-scheduler"
import { disconnectAllAdapters } from "@/lib/appsync-events/reconnect-registry"
import { getSessionCacheScope } from "@/lib/auth/session-cache-scope"
import {
  invalidateReplicationCredentials,
  refreshReplicationCredentials,
} from "@/lib/collections/replication-registry"

interface AuthContextValue {
  session: Session
  /** Unix timestamp in seconds when the access token expires */
  expiresAt: number
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  children,
  session,
  expiresAt,
}: {
  children: ReactNode
  session: Session
  /** Unix timestamp in seconds when the access token expires */
  expiresAt: number
}) {
  const cacheScope = getSessionCacheScope(session)
  const [refreshedExpiry, setRefreshedExpiry] = useState({
    cacheScope,
    source: expiresAt,
    value: expiresAt,
  })
  const [invalidScope, setInvalidScope] = useState<string | null>(null)
  const source = useRef({ cacheScope, expiresAt })
  const currentExpiresAt =
    refreshedExpiry.cacheScope === cacheScope &&
    refreshedExpiry.source === expiresAt
      ? refreshedExpiry.value
      : expiresAt
  const onRefresh = useCallback(
    async (nextExpiresAt: number) => {
      await refreshReplicationCredentials(nextExpiresAt, cacheScope)
      if (
        source.current.cacheScope !== cacheScope ||
        source.current.expiresAt !== expiresAt
      ) {
        throw new Error("Session changed during credential refresh")
      }
      setRefreshedExpiry({
        cacheScope,
        source: expiresAt,
        value: nextExpiresAt,
      })
    },
    [expiresAt, cacheScope],
  )
  const onInvalidSession = useCallback(() => {
    invalidateReplicationCredentials(cacheScope)
    setInvalidScope(cacheScope)
  }, [cacheScope])
  useEffect(() => {
    const previous = source.current
    source.current = { cacheScope, expiresAt }
    if (previous.cacheScope !== cacheScope || previous.expiresAt === expiresAt)
      return
    let cancelled = false
    // A proxy/RSC refresh can also replace credentials without using the timer.
    void refreshReplicationCredentials(expiresAt, cacheScope).catch(() => {
      if (cancelled) return
      invalidateReplicationCredentials(cacheScope)
      disconnectAllAdapters()
      setInvalidScope(cacheScope)
      window.location.reload()
    })
    return () => {
      cancelled = true
    }
  }, [cacheScope, expiresAt])
  const [expiredDeadline, setExpiredDeadline] = useState<number | null>(null)
  const deadline = Math.min(
    currentExpiresAt * 1000,
    "clientId" in session
      ? Infinity
      : (session.delegation?.expiresAt ?? Infinity),
  )
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expire = () => {
      clearTimeout(timer)
      if (!Number.isFinite(deadline) || Date.now() >= deadline) {
        disconnectAllAdapters()
        setExpiredDeadline(deadline)
      } else {
        timer = setTimeout(
          expire,
          Math.min(2_147_483_647, deadline - Date.now()),
        )
      }
    }
    expire()
    document.addEventListener("visibilitychange", expire)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", expire)
    }
  }, [deadline])
  return (
    <AuthContext.Provider value={{ session, expiresAt: currentExpiresAt }}>
      <TokenRefreshScheduler
        initialExpiresAt={currentExpiresAt}
        key={cacheScope}
        session={session}
        onRefresh={onRefresh}
        onInvalidSession={onInvalidSession}
      />
      {invalidScope === cacheScope ||
      !Number.isFinite(deadline) ||
      expiredDeadline === deadline
        ? null
        : children}
    </AuthContext.Provider>
  )
}

/**
 * Hook to access the current session and token expiry.
 * Must be used within an AuthProvider.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}

/**
 * Hook to access just the session (for backwards compatibility).
 */
export function useSession(): Session {
  return useAuth().session
}

export function useOptionalSession(): Session | null {
  return useContext(AuthContext)?.session ?? null
}
