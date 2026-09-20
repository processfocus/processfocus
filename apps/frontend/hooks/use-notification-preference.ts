"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  type DesktopNotificationState,
  disableDesktopNotifications,
  enableDesktopNotifications,
  getDesktopNotificationState,
  isNotificationApiSupported,
  requestNotificationPermission,
  setDesktopNotificationPreference,
} from "@/lib/notifications/notification-preference"

/**
 * Storage event key for cross-tab synchronization
 */
const STORAGE_EVENT_KEY = "pf-notification-preference-changed"

const unsupportedDesktopNotificationState: DesktopNotificationState = {
  isSupported: false,
  permission: "unsupported",
  isEnabled: false,
  isDisabled: true,
}

const areDesktopNotificationStatesEqual = (
  left: DesktopNotificationState,
  right: DesktopNotificationState,
): boolean =>
  left.isSupported === right.isSupported &&
  left.permission === right.permission &&
  left.isEnabled === right.isEnabled &&
  left.isDisabled === right.isDisabled

const dispatchNotificationPreferenceChange = () => {
  if (typeof window === "undefined") {
    return
  }

  window.dispatchEvent(new Event(STORAGE_EVENT_KEY))
}

const FIREFOX_PERMISSION_HINT =
  "Firefox may be waiting in the address bar. Click the notifications icon there to allow or block desktop notifications."

const isFirefoxBrowser = (): boolean => {
  if (typeof navigator === "undefined") {
    return false
  }

  return navigator.userAgent.includes("Firefox")
}

/**
 * Creates a store subscription for the notification preference.
 * Re-renders when permission changes or when localStorage is updated.
 */
const createSubscribe = (userId: string, orgId: string) => {
  return (onStoreChange: () => void) => {
    if (typeof window === "undefined") {
      return () => undefined
    }

    // Listen for storage changes from other tabs
    const handleStorageChange = (event: StorageEvent) => {
      const expectedKey = `pf-desktop-notifications:${userId}:${orgId}`
      if (event.key === expectedKey) {
        onStoreChange()
      }
    }

    // Listen for custom events from same-tab changes
    const handleCustomEvent = () => {
      onStoreChange()
    }

    if (isNotificationApiSupported()) {
      // Note: Notification.permissionchange is not widely supported,
      // so we poll when the window regains focus instead
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          onStoreChange()
        }
      }

      document.addEventListener("visibilitychange", handleVisibilityChange)
      window.addEventListener("storage", handleStorageChange)
      window.addEventListener(STORAGE_EVENT_KEY, handleCustomEvent)

      return () => {
        document.removeEventListener("visibilitychange", handleVisibilityChange)
        window.removeEventListener("storage", handleStorageChange)
        window.removeEventListener(STORAGE_EVENT_KEY, handleCustomEvent)
      }
    }

    window.addEventListener("storage", handleStorageChange)
    window.addEventListener(STORAGE_EVENT_KEY, handleCustomEvent)

    return () => {
      window.removeEventListener("storage", handleStorageChange)
      window.removeEventListener(STORAGE_EVENT_KEY, handleCustomEvent)
    }
  }
}

const getServerSnapshot = (): DesktopNotificationState =>
  unsupportedDesktopNotificationState

/**
 * Hook to manage desktop notification preferences.
 *
 * This hook provides:
 * - Current notification state (supported, permission, enabled)
 * - A toggle function to enable/disable notifications
 * - Automatic re-rendering when permission or preference changes
 *
 * The preference is scoped to the current user and org, stored in localStorage.
 *
 * @param userId - The current user's ID
 * @param orgId - The current organization's ID
 * @returns Object containing state and toggle function
 *
 * @example
 * ```tsx
 * const { state, toggle, isSupported } = useNotificationPreference(userId, orgId);
 *
 * if (!isSupported) return null;
 *
 * return (
 *   <button onClick={toggle} disabled={state.permission === "denied"}>
 *     {state.isEnabled ? "🔔" : "🔕"}
 *   </button>
 * );
 * ```
 */
export function useNotificationPreference(userId: string, orgId: string) {
  const cachedSnapshotRef = useRef<DesktopNotificationState>(
    unsupportedDesktopNotificationState,
  )
  const [isPermissionRequestPending, setIsPermissionRequestPending] =
    useState(false)
  const [browserPromptHint, setBrowserPromptHint] = useState<string | null>(
    null,
  )
  const subscribe = useMemo(
    () => createSubscribe(userId, orgId),
    [userId, orgId],
  )
  const getSnapshot = useCallback((): DesktopNotificationState => {
    if (typeof window === "undefined") {
      return unsupportedDesktopNotificationState
    }

    const nextSnapshot = getDesktopNotificationState(userId, orgId)
    const cachedSnapshot = cachedSnapshotRef.current

    if (areDesktopNotificationStatesEqual(cachedSnapshot, nextSnapshot)) {
      return cachedSnapshot
    }

    cachedSnapshotRef.current = nextSnapshot
    return nextSnapshot
  }, [userId, orgId])

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    if (state.permission !== "default") {
      setIsPermissionRequestPending(false)
      setBrowserPromptHint(null)
    }
  }, [state.permission])

  const toggle = useCallback(async () => {
    if (typeof window === "undefined" || isPermissionRequestPending) return

    if (state.isEnabled) {
      disableDesktopNotifications(userId, orgId)
      setIsPermissionRequestPending(false)
      setBrowserPromptHint(null)
      dispatchNotificationPreferenceChange()
      return
    }

    // Firefox is stricter about notification prompts being tied to a direct
    // user gesture, so keep the permission request in this click handler path.
    if (state.permission === "default" && isNotificationApiSupported()) {
      let showFirefoxHintTimeout: ReturnType<typeof setTimeout> | null = null

      setIsPermissionRequestPending(true)
      setBrowserPromptHint(null)

      if (isFirefoxBrowser()) {
        showFirefoxHintTimeout = setTimeout(() => {
          setBrowserPromptHint(FIREFOX_PERMISSION_HINT)
        }, 1500)
      }

      try {
        const permission = await requestNotificationPermission()

        if (permission === "granted") {
          setDesktopNotificationPreference(userId, orgId, true)
        }
      } catch {
        // Ignore permission request errors and let the derived state stay off.
      }
      if (showFirefoxHintTimeout !== null) {
        clearTimeout(showFirefoxHintTimeout)
      }
      setBrowserPromptHint(null)
      setIsPermissionRequestPending(false)

      dispatchNotificationPreferenceChange()
      return
    }

    await enableDesktopNotifications(userId, orgId)
    setIsPermissionRequestPending(false)
    setBrowserPromptHint(null)
    dispatchNotificationPreferenceChange()
  }, [
    isPermissionRequestPending,
    state.isEnabled,
    state.permission,
    userId,
    orgId,
  ])

  return {
    state,
    toggle,
    isSupported: state.isSupported,
    permission: state.permission,
    isPermissionRequestPending,
    browserPromptHint,
  }
}
