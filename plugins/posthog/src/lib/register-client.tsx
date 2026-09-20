"use client"

import { Suspense, lazy } from "react"
import type {
  FrontendClientPluginGraphqlRequestError,
  FrontendClientPluginRegistration,
  OrganisationFrontendPlugin,
} from "@pf/frontend-plugin-host"
import {
  POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  parsePostHogFrontendClientPluginConfig,
} from "./frontend-client-plugin"
import { getLoadedPostHogClient } from "./posthog-client"
import { PostHogIdentify, resetPostHogIdentity } from "./posthog-identify"
import { subscribeToPostHogReady } from "./posthog-ready-store"

export { shouldActivatePostHogFrontendClientPlugin } from "./activation-policy"

const PostHogEnabledProvider = lazy(() =>
  import("./posthog-enabled-provider").then((module) => ({
    default: module.PostHogEnabledProvider,
  })),
)

interface PendingGraphqlRequestError {
  readonly error: Error
  readonly properties: Record<string, unknown> | undefined
}

const MAX_PENDING_CLIENT_EXCEPTIONS = 20

const pendingClientExceptions: Array<PendingGraphqlRequestError> = []

let hasSubscribedToPostHogReady = false

export const resetFrontendClientPluginForTest = (): void => {
  pendingClientExceptions.splice(0)
  hasSubscribedToPostHogReady = false
}

const buildGraphqlExceptionProperties = (
  details: FrontendClientPluginGraphqlRequestError,
) => ({
  graphql_error_codes: details.graphqlErrors
    .map((graphqlError) => graphqlError.code)
    .filter((code): code is string => code !== null),
  graphql_error_count: details.graphqlErrors.length,
  graphql_error_messages: details.graphqlErrors.map(
    (graphqlError) => graphqlError.message,
  ),
  graphql_error_paths: details.graphqlErrors
    .map((graphqlError) => graphqlError.path)
    .filter((path): path is string => path !== null),
  graphql_operation_name: details.operationName,
  graphql_pathname: details.pathname,
  graphql_response_status: details.responseStatus,
})

const captureClientExceptionWithClient = (
  error: Error,
  properties?: Record<string, unknown>,
): void => {
  const client = getLoadedPostHogClient()

  if (!client) {
    return
  }

  client.captureException(error, properties)
}

const flushPendingClientExceptions = (): void => {
  if (pendingClientExceptions.length === 0) {
    return
  }

  const client = getLoadedPostHogClient()

  if (!client) {
    return
  }

  const queuedErrors = pendingClientExceptions.splice(0)

  for (const queuedError of queuedErrors) {
    client.captureException(queuedError.error, queuedError.properties)
  }
}

const queuePendingClientException = (
  error: Error,
  properties?: Record<string, unknown>,
): void => {
  pendingClientExceptions.push({ error, properties })

  if (pendingClientExceptions.length > MAX_PENDING_CLIENT_EXCEPTIONS) {
    pendingClientExceptions.splice(
      0,
      pendingClientExceptions.length - MAX_PENDING_CLIENT_EXCEPTIONS,
    )
  }

  if (hasSubscribedToPostHogReady) {
    return
  }

  // Keep a single subscription alive so queued errors flush on the first ready
  // transition after any future PostHog re-initialization.
  subscribeToPostHogReady(() => {
    flushPendingClientExceptions()
  })
  hasSubscribedToPostHogReady = true
}

export const frontendClientPlugin = {
  type: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  captureGraphqlRequestError(
    _config: unknown,
    error: Error,
    details: FrontendClientPluginGraphqlRequestError,
  ) {
    flushPendingClientExceptions()
    const properties = buildGraphqlExceptionProperties(details)

    if (!getLoadedPostHogClient()) {
      queuePendingClientException(error, properties)
      return
    }

    captureClientExceptionWithClient(error, properties)
  },
  captureClientException(
    _config: unknown,
    error: Error,
    properties?: Record<string, unknown>,
  ) {
    flushPendingClientExceptions()

    const client = getLoadedPostHogClient()

    if (!client) {
      queuePendingClientException(error, properties)
      return
    }

    captureClientExceptionWithClient(error, properties)
  },
  renderIdentify(
    _config: unknown,
    props: {
      readonly email?: string
      readonly name?: string
      readonly userId: string
      readonly username: string
    },
  ) {
    return <PostHogIdentify {...props} />
  },
  resetIdentity() {
    resetPostHogIdentity()
  },
  render(config: unknown) {
    const posthogConfig = parsePostHogFrontendClientPluginConfig(config)

    return (
      <Suspense fallback={null}>
        <PostHogEnabledProvider config={posthogConfig} />
      </Suspense>
    )
  },
} satisfies FrontendClientPluginRegistration

export const organisationFrontendPlugin = {
  id: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  activate: (host) => {
    host.analytics.register(frontendClientPlugin)
  },
} satisfies OrganisationFrontendPlugin
