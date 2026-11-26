import {
  ORGANISATION_FRONTEND_MANIFEST_VERSION,
  parseOrganisationFrontendManifest,
} from "./frontend-manifest"
import { describe, expect, it } from "bun:test"

const manifest = {
  version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
  embed: { entries: [] },
  plugins: {
    analytics: [
      {
        module: "@another-scope/analytics/browser",
        type: "analytics.example",
        config: { sampleRate: 0.5 },
      },
    ],
    formComponents: [
      {
        module: "unscoped-form-plugin/register-client",
        type: "custom-field",
      },
    ],
  },
}

describe("frontend manifest contract", () => {
  it("parses module metadata without imposing a package scope", () => {
    expect(parseOrganisationFrontendManifest(manifest).plugins).toEqual(
      manifest.plugins,
    )
  })

  it("rejects plugin entries without non-empty module metadata", () => {
    expect(() =>
      parseOrganisationFrontendManifest({
        ...manifest,
        plugins: {
          ...manifest.plugins,
          analytics: [{ type: "analytics.example", config: null }],
        },
      }),
    ).toThrow("plugins.analytics[0].module must be a string")

    expect(() =>
      parseOrganisationFrontendManifest({
        ...manifest,
        plugins: {
          ...manifest.plugins,
          formComponents: [{ module: "  ", type: "custom-field" }],
        },
      }),
    ).toThrow("plugins.formComponents[0].module must be a non-empty string")
  })

  it("rejects stale versions and malformed plugin config", () => {
    expect(() =>
      parseOrganisationFrontendManifest({ ...manifest, version: 1 }),
    ).toThrow("organisation frontend manifest version must be 3, got 1")

    expect(() =>
      parseOrganisationFrontendManifest({
        ...manifest,
        plugins: {
          ...manifest.plugins,
          analytics: [
            {
              module: "example/register-client",
              type: "analytics.example",
              config: { sampleRate: Number.POSITIVE_INFINITY },
            },
          ],
        },
      }),
    ).toThrow("plugins.analytics[0].config.sampleRate must be a finite number")
  })

  it("parses executable embed references and rejects malformed query capabilities", () => {
    const entry = {
      stepPath: "/enrolment/Submit",
      formPath: "/enrolment/Submit",
      processName: "Enrolment",
      processPath: "/enrolment",
      mutationName: "startEnrolment",
      inputTypeName: "EnrolmentSubmit",
      totalFields: 1,
      sites: ["https://school.example.com"],
      thankYou: "Thanks",
      lookups: [],
    }
    const manifest = {
      version: 3,
      embed: { entries: [entry] },
      plugins: { analytics: [], formComponents: [] },
    }
    expect(
      parseOrganisationFrontendManifest(manifest).embed.entries[0],
    ).toEqual(entry)
    expect(() =>
      parseOrganisationFrontendManifest({
        ...manifest,
        embed: { entries: [{ ...entry, lookups: [{}] }] },
      }),
    ).toThrow("type is invalid")
  })
})
