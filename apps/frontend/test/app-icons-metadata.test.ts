import { describe, expect, test } from "vitest"
import { ORGANISATION_FRONTEND_MANIFEST_VERSION } from "@pf/frontend-manifest"
import {
  buildAppIconMetadata,
  buildWebAppManifest,
} from "../lib/app-icons-metadata"
import type { FrontendManifest } from "../lib/frontend-manifest"

const baseManifest: FrontendManifest = {
  version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
  organisation: {
    name: "Test School",
    acronym: "TS",
  },
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

describe("App Icons metadata", () => {
  test("returns empty metadata when no App Icons are configured", () => {
    expect(buildAppIconMetadata(baseManifest)).toEqual({})
  })

  test("builds root metadata from configured App Icons", () => {
    expect(
      buildAppIconMetadata({
        ...baseManifest,
        appIcons: {
          metadata: [
            {
              url: "/_pf/app-icons/favicon.png",
              rel: "icon",
              type: "image/png",
              sizes: "32x32",
            },
            {
              url: "/_pf/app-icons/apple-touch-icon.png",
              rel: "apple-touch-icon",
              type: "image/png",
              sizes: "180x180",
            },
          ],
          manifest: [],
        },
      }),
    ).toEqual({
      icons: {
        icon: [
          {
            url: "/_pf/app-icons/favicon.png",
            rel: "icon",
            type: "image/png",
            sizes: "32x32",
          },
        ],
        other: [
          {
            url: "/_pf/app-icons/apple-touch-icon.png",
            rel: "apple-touch-icon",
            type: "image/png",
            sizes: "180x180",
          },
        ],
      },
    })
  })

  test("builds a web app manifest with organisation identity and icons", () => {
    expect(
      buildWebAppManifest({
        ...baseManifest,
        appIcons: {
          metadata: [],
          manifest: [
            {
              src: "/_pf/app-icons/mask.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
      }),
    ).toEqual({
      name: "Test School",
      short_name: "TS",
      icons: [
        {
          src: "/_pf/app-icons/mask.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    })
  })

  test("omits optional web app manifest fields when not configured", () => {
    expect(
      buildWebAppManifest({
        ...baseManifest,
        organisation: { name: "Test School" },
      }),
    ).toEqual({ name: "Test School" })
  })
})
