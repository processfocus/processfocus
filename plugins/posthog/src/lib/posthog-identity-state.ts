const POSTHOG_IDENTITY_RESET_PENDING_KEY = "pf.posthog.identity-reset-pending"

const canUseSessionStorage = (): boolean =>
  typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"

export const markPostHogIdentityResetPending = (): void => {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.setItem(POSTHOG_IDENTITY_RESET_PENDING_KEY, "1")
}

export const clearPostHogIdentityResetPending = (): void => {
  if (!canUseSessionStorage()) {
    return
  }

  window.sessionStorage.removeItem(POSTHOG_IDENTITY_RESET_PENDING_KEY)
}

export const consumePostHogIdentityResetPending = (): boolean => {
  if (!canUseSessionStorage()) {
    return false
  }

  const isPending =
    window.sessionStorage.getItem(POSTHOG_IDENTITY_RESET_PENDING_KEY) === "1"

  if (isPending) {
    clearPostHogIdentityResetPending()
  }

  return isPending
}
