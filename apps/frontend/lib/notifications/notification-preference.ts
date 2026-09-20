/**
 * Browser-local desktop notification preference management.
 *
 * This module provides a self-service way for provider users to enable/disable
 * desktop notifications in their current browser. The preference is:
 * - Stored in localStorage (not server-side)
 * - Scoped by userId + orgId (isolated across accounts/orgs)
 * - Only available in browsers that support the Notification API
 */

/**
 * Permission state of the browser Notification API
 */
export type NotificationPermissionState =
  | "unsupported"
  | "default"
  | "granted"
  | "denied"

/**
 * Current state of the desktop notification feature
 */
export type DesktopNotificationState = {
  /** Whether the browser supports the Notification API */
  isSupported: boolean
  /** Current browser permission state */
  permission: NotificationPermissionState
  /** Whether the user has enabled notifications in this browser (local preference) */
  isEnabled: boolean
  /**
   * Whether the bell should show as disabled (permission denied or
   * explicitly disabled by user)
   */
  isDisabled: boolean
}

/**
 * Key for localStorage - scoped by user and org
 */
const getPreferenceKey = (userId: string, orgId: string): string =>
  `pf-desktop-notifications:${userId}:${orgId}`

/**
 * Check if the browser supports the Notification API
 */
export const isNotificationApiSupported = (): boolean => {
  if (typeof window === "undefined") return false
  return "Notification" in window
}

/**
 * Get the current browser permission state for notifications.
 * Returns "unsupported" if the Notification API is not available.
 */
export const getBrowserPermissionState = (): NotificationPermissionState => {
  if (!isNotificationApiSupported()) return "unsupported"
  return Notification.permission as NotificationPermissionState
}

/**
 * Read the local preference from localStorage.
 * Returns null if no preference is stored.
 */
const readLocalPreference = (userId: string, orgId: string): boolean | null => {
  if (typeof window === "undefined") return null

  try {
    const key = getPreferenceKey(userId, orgId)
    const stored = window.localStorage.getItem(key)
    if (stored === null) return null
    return stored === "enabled"
  } catch {
    // localStorage access can fail in some browser contexts (private mode, etc.)
    return null
  }
}

/**
 * Save the local preference to localStorage.
 */
const saveLocalPreference = (
  userId: string,
  orgId: string,
  enabled: boolean,
): void => {
  if (typeof window === "undefined") return

  try {
    const key = getPreferenceKey(userId, orgId)
    const value = enabled ? "enabled" : "disabled"
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage access can fail - fail silently
  }
}

export const setDesktopNotificationPreference = (
  userId: string,
  orgId: string,
  enabled: boolean,
): void => {
  saveLocalPreference(userId, orgId, enabled)
}

/**
 * Request browser permission for notifications.
 * Returns the resulting permission state.
 */
export const requestNotificationPermission = async (): Promise<
  Extract<NotificationPermissionState, "granted" | "denied" | "default">
> => {
  if (!isNotificationApiSupported()) return "default"

  try {
    const result = await Notification.requestPermission()
    return result as Extract<
      NotificationPermissionState,
      "granted" | "denied" | "default"
    >
  } catch {
    // requestPermission can throw in some contexts
    return "default"
  }
}

/**
 * Get the current desktop notification state.
 * This is a synchronous check that reads current permission and stored preference.
 */
export const getDesktopNotificationState = (
  userId: string,
  orgId: string,
): DesktopNotificationState => {
  const isSupported = isNotificationApiSupported()
  const permission = getBrowserPermissionState()

  if (!isSupported || permission === "unsupported") {
    return {
      isSupported: false,
      permission: "unsupported",
      isEnabled: false,
      isDisabled: true,
    }
  }

  const localPreference = readLocalPreference(userId, orgId)
  // If permission is denied, the feature is effectively disabled regardless of preference
  const isEnabled = permission === "granted" && localPreference === true
  const isDisabled = permission === "denied" || localPreference === false

  return {
    isSupported: true,
    permission,
    isEnabled,
    isDisabled,
  }
}

/**
 * Attempt to enable desktop notifications.
 * Requests browser permission and persists the preference if granted.
 *
 * Returns the new state after attempting to enable.
 */
export const enableDesktopNotifications = async (
  userId: string,
  orgId: string,
): Promise<DesktopNotificationState> => {
  const permission = getBrowserPermissionState()

  if (!isNotificationApiSupported() || permission === "unsupported") {
    return {
      isSupported: false,
      permission: "unsupported",
      isEnabled: false,
      isDisabled: true,
    }
  }

  // If already granted, just enable and save
  if (permission === "granted") {
    saveLocalPreference(userId, orgId, true)
    return {
      isSupported: true,
      permission: "granted",
      isEnabled: true,
      isDisabled: false,
    }
  }

  // If denied, we can't enable - user must change browser settings
  if (permission === "denied") {
    return {
      isSupported: true,
      permission: "denied",
      isEnabled: false,
      isDisabled: true,
    }
  }

  // Request permission
  const newPermission = await requestNotificationPermission()

  if (newPermission === "granted") {
    saveLocalPreference(userId, orgId, true)
    return {
      isSupported: true,
      permission: "granted",
      isEnabled: true,
      isDisabled: false,
    }
  }

  // Permission denied or dismissed - don't save enabled state
  // If denied, reflect that in the UI
  return {
    isSupported: true,
    permission: newPermission,
    isEnabled: false,
    isDisabled: newPermission === "denied",
  }
}

/**
 * Disable desktop notifications.
 * Clears the local preference.
 */
export const disableDesktopNotifications = (
  userId: string,
  orgId: string,
): DesktopNotificationState => {
  const permission = getBrowserPermissionState()

  if (!isNotificationApiSupported() || permission === "unsupported") {
    return {
      isSupported: false,
      permission: "unsupported",
      isEnabled: false,
      isDisabled: true,
    }
  }

  saveLocalPreference(userId, orgId, false)

  return {
    isSupported: true,
    permission,
    isEnabled: false,
    isDisabled: true,
  }
}
