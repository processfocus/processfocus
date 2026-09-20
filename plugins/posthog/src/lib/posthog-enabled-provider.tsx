"use client"

import type { PostHogConfig } from "posthog-js"
import posthog from "posthog-js"
import * as PostHogReact from "posthog-js/react"
import { Suspense, useLayoutEffect, useMemo } from "react"
import type { PostHogFrontendClientPluginConfig } from "./frontend-client-plugin"
import { PostHogBrowserErrors } from "./posthog-browser-errors"
import {
  type LoadedPostHogClient,
  setLoadedPostHogClient,
} from "./posthog-client"
import { consumePostHogIdentityResetPending } from "./posthog-identity-state"
import { PostHogPageviewTracker } from "./posthog-pageview-tracker"
import { setPostHogReady } from "./posthog-ready-store"
import {
  isPublicFormPathname,
  sanitizePostHogPublicFormEvent,
} from "./posthog-sanitize"

interface PostHogEnabledProviderProps {
  readonly config: PostHogFrontendClientPluginConfig
}

export const buildPostHogOptions = (
  config: PostHogFrontendClientPluginConfig,
): Partial<PostHogConfig> => {
  // This relies on public forms keeping their own route-local plugin layout;
  // before_send must be enabled whenever that provider mounts on a token URL.
  const publicForm = isPublicFormPathname(globalThis.location?.pathname ?? "")

  return {
    api_host: config.host,
    // Freeze PostHog defaults to the behavior set shipped on 2026-01-30.
    defaults: "2026-01-30",
    autocapture: false,
    capture_pageleave: false,
    capture_pageview: false,
    disable_session_recording: true,
    ...(publicForm
      ? {
          advanced_disable_flags: true,
          before_send: sanitizePostHogPublicFormEvent,
          disable_surveys: true,
        }
      : {}),
  }
}

export function PostHogEnabledProvider({
  config,
}: PostHogEnabledProviderProps) {
  const { apiKey, host } = config
  const options = useMemo(
    () => buildPostHogOptions({ apiKey, host }),
    [apiKey, host],
  )

  useLayoutEffect(() => {
    const client = posthog as LoadedPostHogClient

    // Initialize before passive effects so identify/pageview hooks see a ready client.
    if (!client.__loaded) {
      client.init(apiKey, options)
    } else {
      client.set_config(options)
    }

    setLoadedPostHogClient(client)

    if (consumePostHogIdentityResetPending()) {
      client.reset()
    }

    setPostHogReady(true)

    return () => {
      setLoadedPostHogClient(null)
      setPostHogReady(false)
    }
  }, [apiKey, options])

  return (
    <PostHogReact.PostHogProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogBrowserErrors />
        <PostHogPageviewTracker />
      </Suspense>
    </PostHogReact.PostHogProvider>
  )
}
