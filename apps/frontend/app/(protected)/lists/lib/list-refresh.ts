"use client"

const staleListKeyPrefix = "pf:list-stale:"

// Full-page item routes unmount the list before router.refresh() can repaint it.
// Marking the list stale lets the next list mount request fresh server data.
export function markListStale(listPath: string): void {
  try {
    window.sessionStorage.setItem(`${staleListKeyPrefix}${listPath}`, "1")
  } catch {
    // Ignore storage failures; direct router.refresh() still handles current routes.
  }
}

export function consumeListStale(listPath: string): boolean {
  try {
    const key = `${staleListKeyPrefix}${listPath}`
    const isStale = window.sessionStorage.getItem(key) === "1"
    if (isStale) {
      window.sessionStorage.removeItem(key)
    }
    return isStale
  } catch {
    return false
  }
}
