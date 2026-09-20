import { JSDOM } from "jsdom"
import posthog from "posthog-js"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { PostHogBrowserErrors } from "./posthog-browser-errors"
import {
  type LoadedPostHogClient,
  setLoadedPostHogClient,
} from "./posthog-client"
import { setPostHogReady } from "./posthog-ready-store"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

describe("PostHogBrowserErrors", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root
  let captureExceptionCalls: Array<unknown>
  let client: LoadedPostHogClient & {
    captureException: (exception: unknown) => void
  }
  let originalCaptureException: typeof posthog.captureException
  let originalLoaded: boolean | undefined
  let originalPersistence: unknown
  let originalRequestQueue: unknown
  let originalSessionPersistence: unknown

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    captureExceptionCalls = []
    client = posthog as LoadedPostHogClient & {
      captureException: (exception: unknown) => void
    }
    originalCaptureException = client.captureException
    originalLoaded = client.__loaded
    originalPersistence = client.persistence
    originalRequestQueue = client._requestQueue
    originalSessionPersistence = client.sessionPersistence
    client.captureException = (exception: unknown) => {
      captureExceptionCalls.push(exception)
    }
    ;(client as unknown as { persistence: unknown }).persistence = {}
    ;(client as unknown as { _requestQueue: unknown })._requestQueue = {}
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      {}
    setLoadedPostHogClient(null)
    setPostHogReady(false)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })

    client.captureException = originalCaptureException

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

  it("captures uncaught browser errors after PostHog becomes ready", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    const error = new Error("boom")
    const event = new window.Event("error")

    Object.defineProperty(event, "error", {
      configurable: true,
      value: error,
    })

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toEqual([error])
  })

  it("captures unhandled promise rejections through the PostHog client", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    const error = new Error("rejected")
    const event = new window.Event("unhandledrejection")

    Object.defineProperty(event, "reason", {
      configurable: true,
      value: error,
    })

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toEqual([error])
  })

  it("captures primitive unhandled rejection reasons", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    const event = new window.Event("unhandledrejection")

    Object.defineProperty(event, "reason", {
      configurable: true,
      value: "rejected",
    })

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toEqual(["rejected"])
  })

  it("does not install browser error hooks before PostHog is ready", async () => {
    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    const event = new window.Event("error")

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toEqual([])
  })

  it("captures browser error events without an Error object", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    const event = new window.Event("error")

    Object.defineProperty(event, "message", {
      configurable: true,
      value: "script load failed",
    })

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toHaveLength(1)
    expect(captureExceptionCalls[0]).toBeInstanceOf(Error)
    expect((captureExceptionCalls[0] as Error).message).toBe(
      "script load failed",
    )
  })

  it("captures nullish unhandled rejection reasons as synthetic errors", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    const event = new window.Event("unhandledrejection")

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toHaveLength(1)
    expect(captureExceptionCalls[0]).toBeInstanceOf(Error)
    expect((captureExceptionCalls[0] as Error).message).toBe(
      "Unhandled promise rejection",
    )
  })

  it("removes browser error hooks on unmount", async () => {
    client.__loaded = false

    await act(async () => {
      root.render(<PostHogBrowserErrors />)
    })

    client.__loaded = true
    setLoadedPostHogClient(client)

    await act(async () => {
      setPostHogReady(true)
    })

    await act(async () => {
      root.unmount()
    })

    const error = new Error("after unmount")
    const event = new window.Event("error")

    Object.defineProperty(event, "error", {
      configurable: true,
      value: error,
    })

    window.dispatchEvent(event)

    expect(captureExceptionCalls).toEqual([])
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
