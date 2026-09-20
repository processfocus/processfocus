import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type {
  FrontendManifest,
  FrontendManifestAnalyticsPlugin,
} from "../lib/frontend-manifest"
import { FrontendPlugins } from "../lib/plugins-client"

describe("FrontendPlugins", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom("https://console.example.com")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
    vi.restoreAllMocks()
  })

  test("plugin-free composition includes children in the server shell", () => {
    const manifest = {
      ...manifestWithGoogleDrive,
      plugins: { analytics: [], formComponents: [] },
    }
    expect(
      renderToStaticMarkup(
        <FrontendPlugins manifest={manifest}>
          <div data-testid="child" />
        </FrontendPlugins>,
      ),
    ).toContain('data-testid="child"')
  })

  test("configured form plugins gate the server shell until browser activation", () => {
    expect(
      renderToStaticMarkup(
        <FrontendPlugins manifest={manifestWithGoogleDrive}>
          <div data-testid="child" />
        </FrontendPlugins>,
      ),
    ).toBe("")
  })

  test("renders children while manifest plugins load", async () => {
    const deferred =
      createDeferred<ReadonlyArray<FrontendManifestAnalyticsPlugin>>()

    await act(async () => {
      root.render(
        <FrontendPlugins
          manifest={manifestWithPostHog}
          loadPlugins={() => deferred.promise}
        >
          <div data-testid="child" />
        </FrontendPlugins>,
      )
    })

    expect(container.innerHTML).toContain('data-testid="child"')

    await act(async () => {
      deferred.resolve([])
      await deferred.promise
    })

    expect(container.innerHTML).toContain('data-testid="child"')
  })

  test("waits for form component plugins before rendering children", async () => {
    const deferred =
      createDeferred<ReadonlyArray<FrontendManifestAnalyticsPlugin>>()

    await act(async () => {
      root.render(
        <FrontendPlugins
          manifest={manifestWithGoogleDrive}
          loadPlugins={() => deferred.promise}
        >
          <div data-testid="child" />
        </FrontendPlugins>,
      )
    })

    expect(container.innerHTML).toBe("")

    await act(async () => {
      deferred.resolve([])
      await deferred.promise
    })

    expect(container.innerHTML).toContain('data-testid="child"')
  })

  test("renders children after plugin loading fails", async () => {
    const error = new Error("Plugin bundle failed")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    await act(async () => {
      root.render(
        <FrontendPlugins
          manifest={manifestWithPostHog}
          loadPlugins={() => Promise.reject(error)}
        >
          <div data-testid="child" />
        </FrontendPlugins>,
      )
    })

    expect(container.innerHTML).toContain('data-testid="child"')
    expect(consoleError).toHaveBeenCalledWith(
      "[frontend-plugins] failed to load frontend plugins",
      error,
    )
  })

  test("does not render after unmounting during plugin loading", async () => {
    const deferred =
      createDeferred<ReadonlyArray<FrontendManifestAnalyticsPlugin>>()

    await act(async () => {
      root.render(
        <FrontendPlugins
          manifest={manifestWithPostHog}
          loadPlugins={() => deferred.promise}
        >
          <div data-testid="child" />
        </FrontendPlugins>,
      )
    })

    await act(async () => {
      root.unmount()
    })

    await act(async () => {
      deferred.resolve([])
      await deferred.promise
    })

    expect(container.innerHTML).toBe("")
  })
})

const manifestWithPostHog: FrontendManifest = {
  version: 3,
  appIcons: {
    metadata: [],
    manifest: [],
  },
  embed: {
    entries: [],
  },
  plugins: {
    analytics: [
      {
        module: "@processfocus/plugin-posthog/register-client",
        type: "analytics.posthog",
        config: {
          apiKey: "phc_test_123",
          host: "https://us.i.posthog.com",
        },
      },
    ],
    formComponents: [],
  },
}

const manifestWithGoogleDrive: FrontendManifest = {
  version: 3,
  appIcons: {
    metadata: [],
    manifest: [],
  },
  embed: {
    entries: [],
  },
  plugins: {
    analytics: [],
    formComponents: [
      {
        module: "@processfocus/plugin-google-drive/register-client",
        type: "google-drive",
      },
    ],
  },
}

const createDeferred = <T,>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}

const installDom = (url: string): (() => void) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url })

  const previousGlobals = {
    document: globalThis.document,
    history: globalThis.history,
    navigator: globalThis.navigator,
    window: globalThis.window,
  }

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    history: dom.window.history,
    navigator: dom.window.navigator,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
}
