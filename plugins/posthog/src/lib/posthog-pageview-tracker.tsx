"use client"

import { usePathname, useSearchParams } from "next/navigation"
import * as PostHogReact from "posthog-js/react"
import { useEffect, useRef } from "react"
import { sanitizePublicFormUrl } from "./posthog-sanitize"

interface SearchParamsLike {
  toString(): string
}

const buildCurrentUrl = (
  pathname: string,
  searchParams: SearchParamsLike,
  origin: string,
): string => {
  const url = new URL(pathname, origin)
  const search = searchParams.toString()

  if (search) {
    url.search = search
  }

  return sanitizePublicFormUrl(url.toString())
}

export function PostHogPageviewTracker() {
  const pathname = usePathname()
  const posthog = PostHogReact.usePostHog()
  const searchParams = useSearchParams()
  const lastTrackedUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!posthog) {
      return
    }

    const currentUrl = buildCurrentUrl(
      pathname,
      searchParams,
      window.location.origin,
    )

    if (lastTrackedUrlRef.current === currentUrl) {
      return
    }

    lastTrackedUrlRef.current = currentUrl
    posthog.capture("$pageview", { $current_url: currentUrl })
  }, [pathname, posthog, searchParams])

  return null
}
