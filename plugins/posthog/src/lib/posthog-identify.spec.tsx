import { JSDOM } from "jsdom"
import posthog from "posthog-js"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import {
  type LoadedPostHogClient,
  setLoadedPostHogClient,
} from "./posthog-client"
import { PostHogIdentify, resetPostHogIdentity } from "./posthog-identify"
import { setPostHogReady } from "./posthog-ready-store"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

describe("PostHogIdentify", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root
  let client: LoadedPostHogClient & {
    get_distinct_id: () => string
    identify: (...args: unknown[]) => void
    reset: () => void
    setPersonProperties: (...args: unknown[]) => void
  }
  let identifyCalls: unknown[][]
  let resetCalls: number
  let setPersonPropertiesCalls: unknown[][]
  let originalGetDistinctId: typeof posthog.get_distinct_id
  let originalIdentify: typeof posthog.identify
  let originalLoaded: boolean | undefined
  let originalPersistence: unknown
  let originalRequestQueue: unknown
  let originalReset: typeof posthog.reset
  let originalSessionPersistence: unknown
  let originalSetPersonProperties: typeof posthog.setPersonProperties

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    identifyCalls = []
    resetCalls = 0
    setPersonPropertiesCalls = []
    client = posthog as LoadedPostHogClient & {
      get_distinct_id: () => string
      identify: (...args: unknown[]) => void
      reset: () => void
      setPersonProperties: (...args: unknown[]) => void
    }
    originalGetDistinctId = client.get_distinct_id
    originalIdentify = client.identify
    originalLoaded = client.__loaded
    originalPersistence = client.persistence
    originalRequestQueue = client._requestQueue
    originalReset = client.reset
    originalSessionPersistence = client.sessionPersistence
    originalSetPersonProperties = client.setPersonProperties
    client.__loaded = true
    ;(client as unknown as { persistence: unknown }).persistence = {}
    Reflect.deleteProperty(client, "_requestQueue")
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      {}
    client.get_distinct_id = () => "anonymous-id"
    client.identify = (...args: unknown[]) => {
      identifyCalls.push(args)
    }
    client.reset = () => {
      resetCalls += 1
    }
    client.setPersonProperties = (...args: unknown[]) => {
      setPersonPropertiesCalls.push(args)
    }
    setLoadedPostHogClient(client)
    setPostHogReady(false)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })

    client.get_distinct_id = originalGetDistinctId
    ;(client as unknown as { identify: typeof posthog.identify }).identify =
      originalIdentify
    client.reset = originalReset
    ;(
      client as unknown as {
        setPersonProperties: typeof posthog.setPersonProperties
      }
    ).setPersonProperties = originalSetPersonProperties

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
    setPostHogReady(false)
    cleanupDom?.()
  })

  it("identifies with username, email, and name when distinct_id changes", async () => {
    await act(async () => {
      root.render(
        <PostHogIdentify
          email="user@example.com"
          name="User Example"
          userId="usr-123"
          username="usr-123"
        />,
      )
    })

    await act(async () => {
      setPostHogReady(true)
    })

    expect(resetCalls).toBe(1)
    expect(identifyCalls).toEqual([
      [
        "usr-123",
        {
          email: "user@example.com",
          name: "User Example",
          username: "usr-123",
        },
      ],
    ])
    expect(setPersonPropertiesCalls).toEqual([])
  })

  it("updates person properties when already identified as the same user", async () => {
    client.get_distinct_id = () => "usr-123"

    await act(async () => {
      root.render(<PostHogIdentify userId="usr-123" username="usr-123" />)
    })

    await act(async () => {
      setPostHogReady(true)
    })

    expect(resetCalls).toBe(0)
    expect(identifyCalls).toEqual([])
    expect(setPersonPropertiesCalls).toEqual([[{ username: "usr-123" }]])
  })

  it("does not reset identity when profile properties change for the same user", async () => {
    client.get_distinct_id = () => "usr-123"

    await act(async () => {
      root.render(<PostHogIdentify userId="usr-123" username="usr-123" />)
    })

    await act(async () => {
      setPostHogReady(true)
    })

    await act(async () => {
      root.render(
        <PostHogIdentify
          email="user@example.com"
          name="User Example"
          userId="usr-123"
          username="usr-123"
        />,
      )
    })

    expect(resetCalls).toBe(0)
    expect(identifyCalls).toEqual([])
    expect(setPersonPropertiesCalls).toEqual([
      [{ username: "usr-123" }],
      [
        {
          email: "user@example.com",
          name: "User Example",
          username: "usr-123",
        },
      ],
    ])
  })

  it("resets and identifies when the mounted user changes", async () => {
    let currentDistinctId = "usr-123"
    client.get_distinct_id = () => currentDistinctId

    await act(async () => {
      root.render(<PostHogIdentify userId="usr-123" username="usr-123" />)
    })

    await act(async () => {
      setPostHogReady(true)
    })

    currentDistinctId = "usr-123"

    await act(async () => {
      root.render(<PostHogIdentify userId="usr-456" username="usr-456" />)
    })

    expect(resetCalls).toBe(1)
    expect(identifyCalls).toEqual([["usr-456", { username: "usr-456" }]])
    expect(setPersonPropertiesCalls).toEqual([[{ username: "usr-123" }]])
  })

  it("resets identity on unmount", async () => {
    client.get_distinct_id = () => "usr-123"

    await act(async () => {
      root.render(<PostHogIdentify userId="usr-123" username="usr-123" />)
    })

    await act(async () => {
      setPostHogReady(true)
    })

    expect(resetCalls).toBe(0)

    await act(async () => {
      root.unmount()
    })

    expect(resetCalls).toBe(1)
  })

  it("resetPostHogIdentity resets the loaded client", () => {
    resetPostHogIdentity()

    expect(resetCalls).toBe(1)
  })
})

const installDom = (url: string): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })
  const scope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const previousIsReactActEnvironment = scope.IS_REACT_ACT_ENVIRONMENT

  const previousGlobals = {
    document: globalThis.document,
    history: globalThis.history,
    navigator: globalThis.navigator,
    window: globalThis.window,
  }

  Object.assign(scope, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    history: dom.window.history,
    navigator: dom.window.navigator,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)

    if (previousIsReactActEnvironment === undefined) {
      delete scope.IS_REACT_ACT_ENVIRONMENT
    } else {
      scope.IS_REACT_ACT_ENVIRONMENT = previousIsReactActEnvironment
    }
  }
}
