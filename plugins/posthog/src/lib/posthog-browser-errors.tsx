"use client"

import { useEffect, useSyncExternalStore } from "react"
import { getLoadedPostHogClient } from "./posthog-client"
import {
  getPostHogReadySnapshot,
  subscribeToPostHogReady,
} from "./posthog-ready-store"

const getExceptionFromErrorEvent = (event: Event): unknown => {
  const errorEvent = event as ErrorEvent

  if (errorEvent.error != null) {
    return errorEvent.error
  }

  return new Error(errorEvent.message || "Unhandled browser error event")
}

const getExceptionFromUnhandledRejectionEvent = (event: Event): unknown => {
  const rejectionEvent = event as PromiseRejectionEvent

  if (rejectionEvent.reason != null) {
    return rejectionEvent.reason
  }

  return new Error("Unhandled promise rejection")
}

export function PostHogBrowserErrors() {
  const isReady = useSyncExternalStore(
    subscribeToPostHogReady,
    getPostHogReadySnapshot,
    () => false,
  )

  useEffect(() => {
    if (!isReady) {
      return
    }

    const client = getLoadedPostHogClient()

    if (!client) {
      return
    }

    const handleError = (event: Event) => {
      client.captureException(getExceptionFromErrorEvent(event))
    }

    const handleUnhandledRejection = (event: Event) => {
      client.captureException(getExceptionFromUnhandledRejectionEvent(event))
    }

    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleUnhandledRejection)

    return () => {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleUnhandledRejection)
    }
  }, [isReady])

  return null
}
