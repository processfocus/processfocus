import posthog from "posthog-js"
import {
  type LoadedPostHogClient,
  getLoadedPostHogClient,
  setLoadedPostHogClient,
} from "./posthog-client"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

describe("getLoadedPostHogClient", () => {
  let client: LoadedPostHogClient
  let originalLoaded: boolean | undefined
  let originalPersistence: unknown
  let originalRequestQueue: unknown
  let originalSessionPersistence: unknown

  beforeEach(() => {
    client = posthog as LoadedPostHogClient
    originalLoaded = client.__loaded
    originalPersistence = client.persistence
    originalRequestQueue = client._requestQueue
    originalSessionPersistence = client.sessionPersistence

    setLoadedPostHogClient(null)
  })

  afterEach(() => {
    if (originalLoaded === undefined) {
      Reflect.deleteProperty(client, "__loaded")
    } else {
      client.__loaded = originalLoaded
    }

    ;(client as unknown as { persistence: unknown }).persistence =
      originalPersistence
    ;(client as unknown as { _requestQueue: unknown })._requestQueue =
      originalRequestQueue
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      originalSessionPersistence

    setLoadedPostHogClient(null)
  })

  it("returns an initialized client even when browser bundles rename private queue fields", () => {
    client.__loaded = true
    ;(client as unknown as { persistence: unknown }).persistence = {}
    Reflect.deleteProperty(client, "_requestQueue")
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      {}

    setLoadedPostHogClient(client)

    expect(getLoadedPostHogClient()).toBe(client)
  })
})
