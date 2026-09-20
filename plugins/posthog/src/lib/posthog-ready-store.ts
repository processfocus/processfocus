type PostHogReadyListener = () => void

interface PostHogReadyStore {
  isReady: boolean
  listeners: Set<PostHogReadyListener>
}

const POSTHOG_READY_STORE_KEY = "__pfPostHogReadyStore"

const getPostHogReadyStore = (): PostHogReadyStore => {
  const scope = globalThis as typeof globalThis & {
    [POSTHOG_READY_STORE_KEY]?: PostHogReadyStore
  }

  if (!scope[POSTHOG_READY_STORE_KEY]) {
    scope[POSTHOG_READY_STORE_KEY] = {
      isReady: false,
      listeners: new Set<PostHogReadyListener>(),
    }
  }

  return scope[POSTHOG_READY_STORE_KEY]
}

export const getPostHogReadySnapshot = (): boolean =>
  getPostHogReadyStore().isReady

export const setPostHogReady = (isReady: boolean): void => {
  const store = getPostHogReadyStore()

  if (store.isReady === isReady) {
    return
  }

  store.isReady = isReady

  for (const listener of store.listeners) {
    listener()
  }
}

export const subscribeToPostHogReady = (
  listener: PostHogReadyListener,
): (() => void) => {
  const store = getPostHogReadyStore()

  store.listeners.add(listener)

  return () => {
    store.listeners.delete(listener)
  }
}
