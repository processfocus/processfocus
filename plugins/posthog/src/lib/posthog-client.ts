import posthog from "posthog-js"

export type LoadedPostHogClient = typeof posthog & {
  _requestQueue?: unknown
  __loaded?: boolean
  persistence?: unknown
  sessionPersistence?: unknown
}

const POSTHOG_CLIENT_KEY = "__pfLoadedPostHogClient"

const isInitializedPostHogClient = (
  client: LoadedPostHogClient | null | undefined,
): client is LoadedPostHogClient =>
  client != null &&
  client.__loaded === true &&
  client.persistence != null &&
  client.sessionPersistence != null

export const setLoadedPostHogClient = (
  client: LoadedPostHogClient | null,
): void => {
  // Share the initialized client across dynamically imported plugin modules.
  const scope = globalThis as typeof globalThis & {
    [POSTHOG_CLIENT_KEY]?: LoadedPostHogClient | null
  }

  scope[POSTHOG_CLIENT_KEY] = client
}

export const getLoadedPostHogClient = (): LoadedPostHogClient | null => {
  const scope = globalThis as typeof globalThis & {
    [POSTHOG_CLIENT_KEY]?: LoadedPostHogClient | null
  }
  const globalClient = scope[POSTHOG_CLIENT_KEY]

  // posthog-js minifies private transport field names in browser bundles, so
  // capture readiness must rely on stable public init markers only.
  if (isInitializedPostHogClient(globalClient)) {
    return globalClient
  }

  const client = posthog as LoadedPostHogClient

  return isInitializedPostHogClient(client) ? client : null
}

export const getInitializedPostHogClient = (): LoadedPostHogClient | null => {
  const scope = globalThis as typeof globalThis & {
    [POSTHOG_CLIENT_KEY]?: LoadedPostHogClient | null
  }
  const globalClient = scope[POSTHOG_CLIENT_KEY]

  if (isInitializedPostHogClient(globalClient)) {
    return globalClient
  }

  const client = posthog as LoadedPostHogClient

  return isInitializedPostHogClient(client) ? client : null
}
