import { JSDOM } from "jsdom"
import { act } from "react"
import { type Root, createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FrontendClientPluginHost } from "../components/frontend-client-plugin-host"
import { FrontendClientPluginIdentify } from "../components/frontend-client-plugin-identify"
import { FrontendClientPluginProvider } from "../components/frontend-client-plugin-provider"
import {
  clearFrontendClientPlugins,
  registerFrontendClientPlugin,
  resetFrontendClientPluginIdentity,
} from "../lib/frontend-client-plugin-registry"

describe("FrontendClientPluginIdentify", () => {
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
    clearFrontendClientPlugins()

    await act(async () => {
      root.unmount()
    })
    cleanupDom?.()
  })

  test("renders identity components from active frontend plugins", async () => {
    registerFrontendClientPlugin({
      type: "analytics.posthog",
      render: () => null,
      renderIdentify(_config, { email, name, userId, username }) {
        return (
          <div
            data-testid="frontend-plugin-identity"
            data-email={email}
            data-name={name}
            data-user-id={userId}
            data-username={username}
          />
        )
      },
    })

    await act(async () => {
      root.render(
        <FrontendClientPluginProvider
          plugins={[
            {
              type: "analytics.posthog",
              config: {
                apiKey: "phc_test_123",
                host: "https://us.i.posthog.com",
              },
            },
          ]}
        >
          <FrontendClientPluginIdentify
            email="user@example.com"
            name="User Example"
            userId="user-123"
          />
          <FrontendClientPluginHost
            plugins={[
              {
                type: "analytics.posthog",
                config: {
                  apiKey: "phc_test_123",
                  host: "https://us.i.posthog.com",
                },
              },
            ]}
          />
        </FrontendClientPluginProvider>,
      )
    })

    expect(container.innerHTML).toContain(
      'data-testid="frontend-plugin-identity"',
    )
    expect(container.innerHTML).toContain('data-email="user@example.com"')
    expect(container.innerHTML).toContain('data-name="User Example"')
    expect(container.innerHTML).toContain('data-user-id="user-123"')
    expect(container.innerHTML).toContain('data-username="user-123"')
  })

  test("resets registered identity plugins on logout", () => {
    const resetIdentity = vi.fn()

    registerFrontendClientPlugin({
      type: "analytics.posthog",
      render: () => null,
      resetIdentity,
    })

    resetFrontendClientPluginIdentity()

    expect(resetIdentity).toHaveBeenCalledTimes(1)
  })

  test("isolates identity reset failures", () => {
    const healthyReset = vi.fn()
    const failures: string[] = []

    registerFrontendClientPlugin({
      type: "broken",
      render: () => null,
      resetIdentity: () => {
        throw new Error("reset failed")
      },
    })
    registerFrontendClientPlugin({
      type: "healthy",
      render: () => null,
      resetIdentity: healthyReset,
    })

    resetFrontendClientPluginIdentity((_cause, pluginType) =>
      failures.push(pluginType),
    )

    expect(healthyReset).toHaveBeenCalledTimes(1)
    expect(failures).toEqual(["broken"])
  })

  test("isolates failure observer errors during identity reset", () => {
    const healthyReset = vi.fn()

    registerFrontendClientPlugin({
      type: "broken",
      render: () => null,
      resetIdentity: () => {
        throw new Error("reset failed")
      },
    })
    registerFrontendClientPlugin({
      type: "healthy",
      render: () => null,
      resetIdentity: healthyReset,
    })

    expect(() =>
      resetFrontendClientPluginIdentity(() => {
        throw new Error("observer failed")
      }),
    ).not.toThrow()
    expect(healthyReset).toHaveBeenCalledTimes(1)
  })
})

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
