import { afterEach, describe, expect, test, vi } from "vitest"
import {
  type FrontendPluginLoaderMap,
  activateOrganisationFrontendPluginForHost,
  clearFrontendPluginLoaderStateForTest,
  loadFrontendManifestPlugins,
} from "../lib/frontend-plugin-loaders"

describe("frontend plugin loaders", () => {
  const originalNodeEnv = process.env["NODE_ENV"]

  afterEach(() => {
    clearFrontendPluginLoaderStateForTest()
    vi.restoreAllMocks()
    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"]
    } else {
      process.env["NODE_ENV"] = originalNodeEnv
    }
  })

  test("does nothing for a no-plugin manifest", async () => {
    const loader = vi.fn()

    const activePlugins = await loadFrontendManifestPlugins(
      { analytics: [], formComponents: [] },
      { unused: loader },
    )

    expect(activePlugins).toEqual([])
    expect(loader).not.toHaveBeenCalled()
  })

  test("rejects a plugin whose identity differs from its manifest type", async () => {
    const activate = vi.fn()

    await expect(
      activateOrganisationFrontendPluginForHost("expected", {
        id: "unexpected",
        activate,
      }),
    ).rejects.toThrow(
      'Organisation frontend plugin identity "unexpected" does not match manifest type "expected"',
    )
    expect(activate).not.toHaveBeenCalled()
  })

  test("loads analytics and form component plugins from the combined manifest", async () => {
    process.env["NODE_ENV"] = "production"
    const loaded: string[] = []
    const loaders: FrontendPluginLoaderMap = {
      "analytics.posthog": () => {
        loaded.push("analytics.posthog")
      },
      "google-drive": () => {
        loaded.push("google-drive")
      },
    }

    const activePlugins = await loadFrontendManifestPlugins(
      {
        analytics: [
          {
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [{ type: "google-drive" }],
      },
      loaders,
    )

    expect(loaded).toEqual(["analytics.posthog", "google-drive"])
    expect(activePlugins).toEqual([
      {
        type: "analytics.posthog",
        config: {
          apiKey: "phc_test_123",
          host: "https://us.i.posthog.com",
        },
      },
    ])
  })

  test("activates manifest plugins in deterministic order", async () => {
    const activationOrder: string[] = []
    const loaders: FrontendPluginLoaderMap = {
      analytics: async () => {
        await Promise.resolve()
        activationOrder.push("analytics")
      },
      form: () => {
        activationOrder.push("form")
      },
    }

    await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics", config: {} }],
        formComponents: [{ type: "form" }],
      },
      loaders,
    )

    expect(activationOrder).toEqual(["analytics", "form"])
  })

  test("reports missing artifact loaders as plugin failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onFailure = vi.fn()
    await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics.unknown", config: {} }],
        formComponents: [{ type: "form.unknown" }],
      },
      {},
      onFailure,
    )
    expect(onFailure).toHaveBeenCalledWith({
      pluginType: "analytics.unknown",
      cause: expect.any(Error),
    })
    expect(onFailure).toHaveBeenCalledWith({
      pluginType: "form.unknown",
      cause: expect.any(Error),
    })
  })

  test("passes analytics config to loaders and keeps declined plugins inactive", async () => {
    const receivedConfigs: unknown[] = []
    const loaders: FrontendPluginLoaderMap = {
      analytics: (config) => {
        receivedConfigs.push(config)
        return false
      },
    }
    const config = { enabled: false }

    const activePlugins = await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics", config }],
        formComponents: [],
      },
      loaders,
    )

    expect(receivedConfigs).toEqual([config])
    expect(activePlugins).toEqual([])
  })

  test("reevaluates implementation activation policy after a type is loaded", async () => {
    const loader = Object.assign(
      vi.fn(() => true),
      {
        shouldActivate: (config?: unknown) =>
          typeof config === "object" &&
          config !== null &&
          "enabled" in config &&
          config.enabled === true,
      },
    )
    const loaders: FrontendPluginLoaderMap = { analytics: loader }
    const enabled = { type: "analytics", config: { enabled: true } }

    const activePlugins = await loadFrontendManifestPlugins(
      {
        analytics: [enabled, { type: "analytics", config: { enabled: false } }],
        formComponents: [],
      },
      loaders,
    )

    expect(activePlugins).toEqual([enabled])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test("deduplicates concurrent loads for the same plugin type", async () => {
    process.env["NODE_ENV"] = "production"
    const deferred = createDeferred<void>()
    const loader = vi.fn(() => deferred.promise)
    const loaders: FrontendPluginLoaderMap = {
      "analytics.posthog": loader,
    }
    const plugins = {
      analytics: [
        {
          type: "analytics.posthog",
          config: {
            apiKey: "phc_test_123",
            host: "https://us.i.posthog.com",
          },
        },
      ],
      formComponents: [],
    }

    const firstLoad = loadFrontendManifestPlugins(plugins, loaders)
    const secondLoad = loadFrontendManifestPlugins(plugins, loaders)

    expect(loader).toHaveBeenCalledTimes(1)

    deferred.resolve()

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
      plugins.analytics,
      plugins.analytics,
    ])
  })

  test("continues loading other plugins when one loader fails", async () => {
    process.env["NODE_ENV"] = "production"
    const error = new Error("Plugin bundle failed")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const loaders: FrontendPluginLoaderMap = {
      "analytics.broken": () => {
        throw error
      },
      "analytics.posthog": () => {},
      "google-drive": () => {},
    }

    const activePlugins = await loadFrontendManifestPlugins(
      {
        analytics: [
          { type: "analytics.broken", config: {} },
          {
            type: "analytics.posthog",
            config: {
              apiKey: "phc_test_123",
              host: "https://us.i.posthog.com",
            },
          },
        ],
        formComponents: [{ type: "google-drive" }],
      },
      loaders,
    )

    expect(activePlugins).toEqual([
      {
        type: "analytics.posthog",
        config: {
          apiKey: "phc_test_123",
          host: "https://us.i.posthog.com",
        },
      },
    ])
    expect(consoleError).toHaveBeenCalledWith(
      '[frontend-plugin-loaders] failed to load frontend plugin "analytics.broken"',
      error,
    )
  })

  test("reports load failures for analytics and form component plugins", async () => {
    const error = new Error("Plugin bundle failed")
    const _consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    const onPluginFailure = vi.fn()
    const loaders: FrontendPluginLoaderMap = {
      "analytics.broken": () => {
        throw error
      },
      "form.broken": () => {
        throw error
      },
    }

    await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics.broken", config: {} }],
        formComponents: [{ type: "form.broken" }],
      },
      loaders,
      onPluginFailure,
    )

    expect(onPluginFailure).toHaveBeenCalledWith({
      pluginType: "analytics.broken",
      cause: error,
    })
    expect(onPluginFailure).toHaveBeenCalledWith({
      pluginType: "form.broken",
      cause: error,
    })
  })

  test("reports configured plugins without registered loaders as failures", async () => {
    const _consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onPluginFailure = vi.fn()

    await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics.unknown", config: {} }],
        formComponents: [{ type: "form.unknown" }],
      },
      {},
      onPluginFailure,
    )

    expect(onPluginFailure).toHaveBeenCalledTimes(2)
    expect(onPluginFailure).toHaveBeenCalledWith({
      pluginType: "analytics.unknown",
      cause: expect.objectContaining({
        message:
          'No organisation frontend plugin loader is registered for "analytics.unknown"',
      }),
    })
    expect(onPluginFailure).toHaveBeenCalledWith({
      pluginType: "form.unknown",
      cause: expect.objectContaining({
        message:
          'No organisation frontend plugin loader is registered for "form.unknown"',
      }),
    })
  })

  test("does not report intentionally skipped plugins as failures", async () => {
    const onPluginFailure = vi.fn()
    const loaders: FrontendPluginLoaderMap = {
      analytics: () => false,
    }

    await loadFrontendManifestPlugins(
      {
        analytics: [{ type: "analytics", config: { enabled: false } }],
        formComponents: [],
      },
      loaders,
      onPluginFailure,
    )

    expect(onPluginFailure).not.toHaveBeenCalled()
  })
})

const createDeferred = <T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}
