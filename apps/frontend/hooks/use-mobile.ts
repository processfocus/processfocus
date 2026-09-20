import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

const getIsMobile = () => {
  if (typeof window === "undefined") {
    return false
  }

  return window.innerWidth < MOBILE_BREAKPOINT
}

const subscribe = (onStoreChange: () => void) => {
  if (typeof window === "undefined") {
    return () => undefined
  }

  const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY)
  const handleChange = () => onStoreChange()
  mediaQuery.addEventListener("change", handleChange)

  return () => mediaQuery.removeEventListener("change", handleChange)
}

export const useIsMobile = () =>
  React.useSyncExternalStore(subscribe, getIsMobile, () => false)
