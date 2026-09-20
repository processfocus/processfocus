import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test } from "vitest"
import { FrontendClientPluginHost } from "../components/frontend-client-plugin-host"
import {
  clearFrontendClientPlugins,
  registerFrontendClientPlugin,
} from "../lib/frontend-client-plugin-registry"

describe("FrontendClientPluginHost", () => {
  afterEach(() => {
    clearFrontendClientPlugins()
  })

  test("stays inert when no plugin registration matches the manifest", () => {
    const markup = renderToStaticMarkup(
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
      />,
    )

    expect(markup).toBe("")
  })

  test("renders registered client plugins from the manifest", () => {
    registerFrontendClientPlugin({
      type: "analytics.posthog",
      render(config) {
        const posthogConfig = config as {
          readonly apiKey: string
          readonly host: string
        }

        return (
          <div
            data-api-key={posthogConfig.apiKey}
            data-host={posthogConfig.host}
            data-testid="frontend-client-plugin"
          />
        )
      },
    })

    const markup = renderToStaticMarkup(
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
      />,
    )

    expect(markup).toContain('data-testid="frontend-client-plugin"')
    expect(markup).toContain('data-api-key="phc_test_123"')
    expect(markup).toContain('data-host="https://us.i.posthog.com"')
  })
})
