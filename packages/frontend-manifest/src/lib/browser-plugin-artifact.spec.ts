import {
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
  BROWSER_PLUGIN_CATEGORIES,
  type BrowserPluginArtifactManifest,
  isBrowserPluginCategory,
  parseBrowserPluginArtifactManifest,
} from "./browser-plugin-artifact"
import { describe, expect, it } from "bun:test"

const manifest = (
  plugins: BrowserPluginArtifactManifest["plugins"],
): BrowserPluginArtifactManifest => ({
  format: BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
  version: BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
  plugins,
})

const postHog: BrowserPluginArtifactManifest["plugins"][number] = {
  identity: "analytics.posthog",
  category: "analytics",
  hostInterfaceVersion: 1,
  path: `browser-plugins/${"a".repeat(64)}.js`,
  sha256: "a".repeat(64),
}

const googleDrive: BrowserPluginArtifactManifest["plugins"][number] = {
  identity: "google-drive",
  category: "formComponents",
  hostInterfaceVersion: 1,
  path: `browser-plugins/${"b".repeat(64)}.js`,
  sha256: "b".repeat(64),
  preparation: {
    kind: "stylesheet",
    path: `browser-plugins/${"c".repeat(64)}.css`,
    sha256: "c".repeat(64),
  },
}

describe("browser plugin artifact manifest", () => {
  it("recognizes categories from the authoritative category list", () => {
    for (const category of BROWSER_PLUGIN_CATEGORIES) {
      expect(isBrowserPluginCategory(category)).toBe(true)
    }
    expect(isBrowserPluginCategory("notifications")).toBe(false)
  })

  it("parses the browser artifact contract", () => {
    expect(
      parseBrowserPluginArtifactManifest(manifest([postHog, googleDrive])),
    ).toEqual(manifest([postHog, googleDrive]))
  })

  it("rejects duplicate identities with the plugin identity", () => {
    expect(() =>
      parseBrowserPluginArtifactManifest(manifest([postHog, postHog])),
    ).toThrow('duplicate identity "analytics.posthog"')
  })

  it.each(["../posthog.js", "/posthog.js", "browser-plugins\\posthog.js"])(
    "rejects an artifact path that escapes or is not portable: %s",
    (path) => {
      expect(() =>
        parseBrowserPluginArtifactManifest(manifest([{ ...postHog, path }])),
      ).toThrow(
        'browser plugin "analytics.posthog" path must stay within the artifact root',
      )
    },
  )

  it("rejects invalid integrity and interface versions", () => {
    expect(() =>
      parseBrowserPluginArtifactManifest(
        manifest([{ ...postHog, sha256: "changed" }]),
      ),
    ).toThrow('browser plugin "analytics.posthog" sha256')
    expect(() =>
      parseBrowserPluginArtifactManifest(
        manifest([{ ...postHog, hostInterfaceVersion: 0 }]),
      ),
    ).toThrow('browser plugin "analytics.posthog" hostInterfaceVersion')
  })

  it("rejects invalid preparation artifacts", () => {
    expect(() =>
      parseBrowserPluginArtifactManifest(
        manifest([
          {
            ...googleDrive,
            preparation: {
              ...googleDrive.preparation!,
              path: "../google-drive.css",
            },
          },
        ]),
      ),
    ).toThrow('browser plugin "google-drive" preparation.path')
    expect(() =>
      parseBrowserPluginArtifactManifest(
        manifest([
          {
            ...googleDrive,
            preparation: {
              ...googleDrive.preparation!,
              sha256: "changed",
            },
          },
        ]),
      ),
    ).toThrow('browser plugin "google-drive" preparation.sha256')
  })
})
