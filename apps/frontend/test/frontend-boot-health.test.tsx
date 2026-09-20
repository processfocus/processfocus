import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FrontendBootHealth } from "../lib/frontend-boot-health"
import {
  clearFrontendClientPlugins,
  registerFrontendClientPlugin,
} from "../lib/frontend-client-plugin-registry"
import type { FrontendManifest } from "../lib/frontend-manifest"
import { clearFrontendPluginLoaderStateForTest } from "../lib/frontend-plugin-loaders"

describe("FrontendBootHealth", () => {
  let cleanupDom: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cleanupDom = installDom("https://dashboard.example.com/_pf/health")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
    clearFrontendClientPlugins()
    clearFrontendPluginLoaderStateForTest()
    vi.restoreAllMocks()
  })

  test("reports ready for an organisation without plugins", async () => {
    const deferred =
      createDeferred<ReadonlyArray<FrontendManifest["plugins"]["analytics"]>>()

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={emptyManifest.plugins}
          loadPlugins={() => deferred.promise}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("booting")

    await act(async () => {
      deferred.resolve([])
      await deferred.promise
    })

    expect(bootHealthPhase(container)).toBe("ready")
  })

  test("reports ready only after a healthy plugin composition loads and renders", async () => {
    registerFrontendClientPlugin({
      type: "analytics.probe",
      render: () => <div data-testid="healthy-plugin" />,
    })
    const deferred =
      createDeferred<ReadonlyArray<FrontendManifest["plugins"]["analytics"]>>()

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={() => deferred.promise}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("booting")
    expect(container.innerHTML).not.toContain("healthy-plugin")

    await act(async () => {
      deferred.resolve(manifestWithProbe.plugins.analytics)
      await deferred.promise
    })

    expect(bootHealthPhase(container)).toBe("ready")
    expect(container.innerHTML).toContain("healthy-plugin")
  })

  test("reports failed when a plugin import fails and keeps the error observable", async () => {
    const _consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    const error = new Error("Plugin bundle failed to import")

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={(_plugins, _loaders, onPluginFailure) => {
            onPluginFailure?.({ pluginType: "analytics.probe", cause: error })
            return Promise.resolve([])
          }}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("failed")
    expect(container.innerHTML).not.toContain("healthy-plugin")
  })

  test("reports failed when the plugin load promise rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("Plugin composition failed")

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={() => Promise.reject(error)}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("failed")
    expect(consoleError).toHaveBeenCalledWith(
      "[frontend-boot-health] failed to load frontend plugins",
      error,
    )
  })

  test("reports failed when a plugin render throws and keeps the error observable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("Plugin render failed")
    registerFrontendClientPlugin({
      type: "analytics.probe",
      render: () => {
        throw error
      },
    })

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={(plugins) => Promise.resolve(plugins.analytics)}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("failed")
    expect(consoleError).toHaveBeenCalledWith(
      "[frontend-boot-health] frontend plugin render failed",
      error,
    )
  })

  test("downgrades the ready marker to failed when a plugin render fails later", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    let shouldThrow = false
    const error = new Error("Plugin render failed late")
    registerFrontendClientPlugin({
      type: "analytics.probe",
      render: () => {
        if (shouldThrow) {
          throw error
        }

        return <div data-testid="healthy-plugin" />
      },
    })

    await act(async () => {
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={(plugins) => Promise.resolve(plugins.analytics)}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("ready")

    await act(async () => {
      shouldThrow = true
      root.render(
        <FrontendBootHealth
          plugins={manifestWithProbe.plugins}
          loadPlugins={(plugins) => Promise.resolve(plugins.analytics)}
        />,
      )
    })

    expect(bootHealthPhase(container)).toBe("failed")
    expect(consoleError).toHaveBeenCalledWith(
      "[frontend-boot-health] frontend plugin render failed",
      error,
    )
  })
})

const emptyManifest: FrontendManifest = {
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
    formComponents: [],
  },
}

const manifestWithProbe: FrontendManifest = {
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
        type: "analytics.probe",
        config: {
          enabled: true,
        },
      },
    ],
    formComponents: [],
  },
}

const bootHealthPhase = (element: HTMLElement): string | null =>
  element
    .querySelector("#frontend-boot-health")
    ?.getAttribute("data-frontend-boot-health") ?? null

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
    history: globalThis.history,
    navigator: dom.window.navigator,
    window: dom.window,
  })

  return () => {
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
}
