import { describe, expect, it } from "vitest"
import {
  ORGANISATION_DEPLOY_MANIFEST_VERSION,
  parseOrganisationDeployManifest,
} from "./organisation-deploy-manifest.js"

const manifest = {
  format: "processfocus/deploy-manifest",
  version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
  producer: { name: "@processfocus/cli", version: "0.1.0-next.0" },
  orgBundleSha256: "a".repeat(64),
  organisationTimeZone: "Pacific/Auckland",
  hasLongDurationSteps: false,
  dockerSteps: [
    {
      stepPath: "/operations/deploy/Execute",
      dockerContext: "context",
      dockerfile: "Dockerfile",
    },
  ],
  documentStores: [],
  cronEntries: [
    {
      processPath: "/operations/report",
      startMutationName: "startOperationsReport",
      cron: { type: "monthly", dayOfMonth: 1, at: { hour: 9, minute: 30 } },
    },
  ],
  extensions: {},
}

describe("organisation deploy manifest runtime contract", () => {
  it("parses the portable artifact without authoring implementation packages", () => {
    expect(parseOrganisationDeployManifest(manifest)).toMatchObject(manifest)
  })

  it.each([2, 4, 99, "3", undefined])(
    "rejects unsupported manifest version %s",
    (version) => {
      expect(() =>
        parseOrganisationDeployManifest({ ...manifest, version }),
      ).toThrow("organisation deploy manifest version must be 3")
    },
  )

  it("preserves provider extensions as opaque data", () => {
    const parsed = parseOrganisationDeployManifest({
      ...manifest,
      extensions: {
        "provider/runtime": { arbitrary: ["candidate-function"] },
      },
    })

    expect(parsed.extensions).toEqual({
      "provider/runtime": { arbitrary: ["candidate-function"] },
    })
  })

  it("rejects an unbranded manifest", () => {
    const { format: _format, ...unbrandedManifest } = manifest

    expect(() => parseOrganisationDeployManifest(unbrandedManifest)).toThrow(
      "organisation deploy manifest format must be processfocus/deploy-manifest",
    )
  })

  it("rejects v1 manifests that predate executor descriptors", () => {
    expect(() =>
      parseOrganisationDeployManifest({
        ...manifest,
        version: 1,
        dockerSteps: [
          {
            ...manifest.dockerSteps[0],
            executor: "legacy-executor",
          },
        ],
      }),
    ).toThrow("organisation deploy manifest version must be 3")
  })

  it("does not expose provider policy from the portable Docker step shape", () => {
    const parsed = parseOrganisationDeployManifest({
      ...manifest,
      dockerSteps: [
        { ...manifest.dockerSteps[0], executor: "provider-specific" },
      ],
    })

    expect(parsed.dockerSteps[0]).not.toHaveProperty("executor")
  })
})
