import { Construct, type IConstruct } from "constructs"
import { Config } from "effect"
import {
  POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
  parsePostHogFrontendClientPluginConfig,
} from "./frontend-client-plugin"
import { PostHog } from "./posthog"
import { describe, expect, it } from "bun:test"

class RootConstruct extends Construct {
  constructor() {
    super(undefined as unknown as IConstruct, "root")
  }
}

describe("PostHog", () => {
  it("exposes the generic frontend plugin marker and public browser config", () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "test"

    try {
      const root = new RootConstruct()
      const posthog = new PostHog(root, "posthog", {
        apiKey: "  phc_test_123  ",
        host: "https://us.i.posthog.com/",
      })

      expect(posthog.isFrontendClientPluginManifestProvider).toBe(true)
      expect(posthog.isBrowserPluginArtifactProvider).toBe(true)
      expect(posthog.frontendManifestPluginCategory).toBe("analytics")
      expect(posthog.node.id).toBe("posthog")
      expect(posthog.apiKey).toBe("phc_test_123")
      expect(posthog.host).toBe("https://us.i.posthog.com")
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env["NODE_ENV"]
      } else {
        process.env["NODE_ENV"] = originalNodeEnv
      }
    }
  })

  it("rejects invalid host values", () => {
    const root = new RootConstruct()

    expect(
      () =>
        new PostHog(root, "posthog", {
          apiKey: "phc_test_123",
          host: "ftp://example.com",
        }),
    ).toThrow("PostHog host must be a valid http(s) URL")
  })

  it("serializes a generic frontend plugin manifest entry", () => {
    const root = new RootConstruct()
    const posthog = new PostHog(root, "posthog", {
      apiKey: "phc_test_123",
      host: "https://us.i.posthog.com",
    })

    expect(posthog.buildFrontendClientPluginManifest()).toEqual({
      module: "@processfocus/plugin-posthog/register-client",
      type: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
      config: {
        apiKey: "phc_test_123",
        host: "https://us.i.posthog.com",
      },
    })
    expect(posthog.buildBrowserPluginArtifact()).toEqual({
      identity: "analytics.posthog",
      category: "analytics",
      hostInterfaceVersion: 1,
      entrypoint: "@processfocus/plugin-posthog/browser",
    })
  })

  it("does not expose the analytics category in local development by default", () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "development"

    try {
      const root = new RootConstruct()
      const posthog = new PostHog(root, "posthog", {
        apiKey: "phc_test_123",
        host: "https://us.i.posthog.com",
      })

      expect(posthog.frontendManifestPluginCategory).toBeUndefined()
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env["NODE_ENV"]
      } else {
        process.env["NODE_ENV"] = originalNodeEnv
      }
    }
  })

  it("can expose the analytics category in local development for testing", () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "development"

    try {
      const root = new RootConstruct()
      const posthog = new PostHog(root, "posthog", {
        apiKey: "phc_test_123",
        host: "https://us.i.posthog.com",
        enabled: true,
      })

      expect(posthog.frontendManifestPluginCategory).toBe("analytics")
      expect(posthog.buildFrontendClientPluginManifest()).toEqual({
        module: "@processfocus/plugin-posthog/register-client",
        type: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
        config: {
          apiKey: "phc_test_123",
          enabled: true,
          host: "https://us.i.posthog.com",
        },
      })
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env["NODE_ENV"]
      } else {
        process.env["NODE_ENV"] = originalNodeEnv
      }
    }
  })

  it("disables analytics when enabled is explicitly false", () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "test"

    try {
      const root = new RootConstruct()
      const posthog = new PostHog(root, "posthog", {
        apiKey: "phc_test_123",
        host: "https://us.i.posthog.com",
        enabled: false,
      })

      expect(posthog.frontendManifestPluginCategory).toBeUndefined()
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env["NODE_ENV"]
      } else {
        process.env["NODE_ENV"] = originalNodeEnv
      }
    }
  })

  it("resolves apiKey from Effect Config when serializing the manifest entry", () => {
    const root = new RootConstruct()
    const originalToken = process.env["TEST_POSTHOG_PROJECT_TOKEN"]

    process.env["TEST_POSTHOG_PROJECT_TOKEN"] = "phc_test_from_env"

    try {
      const posthog = new PostHog(root, "posthog", {
        apiKey: Config.string("TEST_POSTHOG_PROJECT_TOKEN"),
        host: "https://us.i.posthog.com",
      })

      expect(posthog.buildFrontendClientPluginManifest()).toEqual({
        module: "@processfocus/plugin-posthog/register-client",
        type: POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE,
        config: {
          apiKey: "phc_test_from_env",
          host: "https://us.i.posthog.com",
        },
      })
    } finally {
      if (originalToken === undefined) {
        delete process.env["TEST_POSTHOG_PROJECT_TOKEN"]
      } else {
        process.env["TEST_POSTHOG_PROJECT_TOKEN"] = originalToken
      }
    }
  })

  it("parses and normalizes PostHog client plugin config", () => {
    expect(
      parsePostHogFrontendClientPluginConfig({
        apiKey: "phc_test_123",
        host: "https://us.i.posthog.com/",
      }),
    ).toEqual({
      apiKey: "phc_test_123",
      host: "https://us.i.posthog.com",
    })
  })

  it("rejects malformed PostHog client plugin config", () => {
    expect(() =>
      parsePostHogFrontendClientPluginConfig({
        apiKey: "",
        host: "https://us.i.posthog.com",
      }),
    ).toThrow(
      "posthog frontend client plugin config.apiKey must be a non-empty string",
    )

    expect(() =>
      parsePostHogFrontendClientPluginConfig({
        apiKey: "phc_test_123",
        host: "ftp://bad",
      }),
    ).toThrow(
      "posthog frontend client plugin config.host must be a valid http(s) URL",
    )

    expect(() =>
      parsePostHogFrontendClientPluginConfig({
        apiKey: "phc_test_123",
        enabled: "false",
        host: "https://us.i.posthog.com",
      }),
    ).toThrow("posthog frontend client plugin config.enabled must be a boolean")
  })

  it("builds PostHog options that keep only the pageview slice enabled", async () => {
    const { buildPostHogOptions } = await import("./posthog-enabled-provider")

    const options = buildPostHogOptions({
      apiKey: "phc_test_123",
      host: "https://us.i.posthog.com",
    })

    expect(options).toMatchObject({
      api_host: "https://us.i.posthog.com",
      defaults: "2026-01-30",
      autocapture: false,
      capture_pageleave: false,
      capture_pageview: false,
      disable_session_recording: true,
    })
    expect(options.before_send).toBeUndefined()
  })

  it("redacts public form capability tokens from PostHog events", async () => {
    const { sanitizePostHogPublicFormEvent, sanitizePublicFormUrl } =
      await import("./posthog-sanitize")
    const timestamp = new Date("2026-05-09T00:00:00.000Z")
    const url = new URL("https://example.com/public/form/url-object-token")
    const error = new Error("keeps prototype data")
    const circular: Record<string, unknown> = {
      $current_url: "https://example.com/public/form/circular-token",
    }
    circular["self"] = circular

    expect(
      sanitizePublicFormUrl(
        "https://example.com/public/form/secret-token.value?utm=1",
      ),
    ).toBe("https://example.com/public/form/[token]?utm=1")

    expect(
      sanitizePostHogPublicFormEvent({
        properties: {
          $current_url: "https://example.com/public/form/secret-token.value",
          combined:
            "/public/form/first-token and /public/form/second-token?next=1",
          circular,
          error,
          nested: ["/public/form/another-token"],
          timestamp,
          url,
        },
      }),
    ).toEqual({
      properties: {
        $current_url: "https://example.com/public/form/[token]",
        combined: "/public/form/[token] and /public/form/[token]?next=1",
        circular: {
          $current_url: "https://example.com/public/form/[token]",
          self: "[Circular]",
        },
        error,
        nested: ["/public/form/[token]"],
        timestamp,
        url,
      },
    })
  })

  it("disables PostHog flags and surveys on public form pages", async () => {
    const { buildPostHogOptions } = await import("./posthog-enabled-provider")
    const originalLocation = globalThis.location

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/public/form/secret-token.value" },
    })

    try {
      expect(
        buildPostHogOptions({
          apiKey: "phc_test_123",
          host: "https://us.i.posthog.com",
        }),
      ).toMatchObject({
        advanced_disable_flags: true,
        before_send: expect.any(Function),
        disable_surveys: true,
      })
    } finally {
      if (originalLocation === undefined) {
        Reflect.deleteProperty(globalThis, "location")
      } else {
        Object.defineProperty(globalThis, "location", {
          configurable: true,
          value: originalLocation,
        })
      }
    }
  })
})
