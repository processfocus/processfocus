import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import {
  disableDesktopNotifications,
  enableDesktopNotifications,
  getBrowserPermissionState,
  getDesktopNotificationState,
  isNotificationApiSupported,
  requestNotificationPermission,
} from "../lib/notifications/notification-preference"

const browserGlobal = globalThis as typeof globalThis & {
  Notification?: {
    permission: NotificationPermission
    requestPermission: () => Promise<NotificationPermission>
  }
  localStorage: Storage
}
const browserWindow =
  typeof window === "undefined" ? undefined : (window as typeof browserGlobal)

const notificationPreferenceKey = (userId: string, orgId: string) =>
  `pf-desktop-notifications:${userId}:${orgId}`

const originalNotificationDescriptor = Object.getOwnPropertyDescriptor(
  browserGlobal,
  "Notification",
)
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  browserGlobal,
  "window",
)
const originalWindowNotificationDescriptor = browserWindow
  ? Object.getOwnPropertyDescriptor(browserWindow, "Notification")
  : undefined
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  browserGlobal,
  "localStorage",
)
const originalWindowLocalStorageDescriptor = browserWindow
  ? Object.getOwnPropertyDescriptor(browserWindow, "localStorage")
  : undefined

let localStorageState = new Map<string, string>()

const defineBrowserProperty = (
  propertyName: "Notification" | "localStorage",
  value: unknown,
) => {
  Object.defineProperty(browserGlobal, propertyName, {
    configurable: true,
    writable: true,
    value,
  })

  if (browserWindow && browserWindow !== browserGlobal) {
    Object.defineProperty(browserWindow, propertyName, {
      configurable: true,
      writable: true,
      value,
    })
  }
}

const deleteBrowserProperty = (
  propertyName: "Notification" | "localStorage",
) => {
  Reflect.deleteProperty(browserGlobal, propertyName)

  if (browserWindow && browserWindow !== browserGlobal) {
    Reflect.deleteProperty(browserWindow, propertyName)
  }
}

const stubNotificationApi = (
  permission: NotificationPermission,
  requestPermission: () => Promise<NotificationPermission> = vi
    .fn()
    .mockResolvedValue(permission),
) => {
  defineBrowserProperty("Notification", {
    permission,
    requestPermission,
  })

  return requestPermission
}

const removeNotificationApi = () => {
  deleteBrowserProperty("Notification")
}

beforeEach(() => {
  localStorageState = new Map<string, string>()

  Object.defineProperty(browserGlobal, "window", {
    configurable: true,
    writable: true,
    value: browserGlobal,
  })

  defineBrowserProperty("localStorage", {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value)
    },
    removeItem: (key: string) => {
      localStorageState.delete(key)
    },
  })

  removeNotificationApi()
})

afterAll(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(browserGlobal, "window", originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(browserGlobal, "window")
  }

  if (originalNotificationDescriptor) {
    Object.defineProperty(
      browserGlobal,
      "Notification",
      originalNotificationDescriptor,
    )
  } else {
    deleteBrowserProperty("Notification")
  }

  if (browserWindow && browserWindow !== browserGlobal) {
    if (originalWindowNotificationDescriptor) {
      Object.defineProperty(
        browserWindow,
        "Notification",
        originalWindowNotificationDescriptor,
      )
    } else {
      Reflect.deleteProperty(browserWindow, "Notification")
    }
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(
      browserGlobal,
      "localStorage",
      originalLocalStorageDescriptor,
    )
  }

  if (browserWindow && browserWindow !== browserGlobal) {
    if (originalWindowLocalStorageDescriptor) {
      Object.defineProperty(
        browserWindow,
        "localStorage",
        originalWindowLocalStorageDescriptor,
      )
    } else {
      Reflect.deleteProperty(browserWindow, "localStorage")
    }
  }
})

describe("notification preference module", () => {
  test("reports unsupported when Notification API is unavailable", () => {
    expect(isNotificationApiSupported()).toBe(false)
    expect(getBrowserPermissionState()).toBe("unsupported")
    expect(getDesktopNotificationState("user-1", "org-1")).toEqual({
      isSupported: false,
      permission: "unsupported",
      isEnabled: false,
      isDisabled: true,
    })
  })

  test("enables notifications immediately when permission is already granted", async () => {
    stubNotificationApi("granted")

    const state = await enableDesktopNotifications("user-1", "org-1")

    expect(state).toEqual({
      isSupported: true,
      permission: "granted",
      isEnabled: true,
      isDisabled: false,
    })
    expect(
      localStorageState.get(notificationPreferenceKey("user-1", "org-1")),
    ).toBe("enabled")
  })

  test("requests permission and enables notifications when the browser grants access", async () => {
    const requestPermission = stubNotificationApi(
      "default",
      vi.fn().mockResolvedValue("granted"),
    )

    const state = await enableDesktopNotifications("user-1", "org-1")

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(state).toEqual({
      isSupported: true,
      permission: "granted",
      isEnabled: true,
      isDisabled: false,
    })
    expect(
      localStorageState.get(notificationPreferenceKey("user-1", "org-1")),
    ).toBe("enabled")
  })

  test("denied browser permission keeps notifications disabled even when the local preference was enabled", () => {
    stubNotificationApi("denied")
    localStorageState.set(
      notificationPreferenceKey("user-1", "org-1"),
      "enabled",
    )

    expect(getDesktopNotificationState("user-1", "org-1")).toEqual({
      isSupported: true,
      permission: "denied",
      isEnabled: false,
      isDisabled: true,
    })
  })

  test("disabling notifications stores an explicit disabled preference", () => {
    stubNotificationApi("granted")
    localStorageState.set(
      notificationPreferenceKey("user-1", "org-1"),
      "enabled",
    )

    const state = disableDesktopNotifications("user-1", "org-1")

    expect(state).toEqual({
      isSupported: true,
      permission: "granted",
      isEnabled: false,
      isDisabled: true,
    })
    expect(
      localStorageState.get(notificationPreferenceKey("user-1", "org-1")),
    ).toBe("disabled")
  })

  test("scopes notification preferences by user and org", async () => {
    stubNotificationApi("granted")

    await enableDesktopNotifications("user-a", "org-1")

    expect(getDesktopNotificationState("user-a", "org-1").isEnabled).toBe(true)
    expect(getDesktopNotificationState("user-a", "org-2").isEnabled).toBe(false)
    expect(getDesktopNotificationState("user-b", "org-1").isEnabled).toBe(false)
  })

  test("returns default when requesting permission throws", async () => {
    stubNotificationApi("default", vi.fn().mockRejectedValue(new Error("boom")))

    await expect(requestNotificationPermission()).resolves.toBe("default")
  })
})
