import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  UnsupportedArtifactVersionError,
  parseRuntimeArtifact,
} from "./artifact.js"
import {
  ArtifactInventoryParseError,
  parseArtifactInventory,
} from "./artifact-inventory.js"
import {
  DEPLOY_ARTIFACT_FORMAT,
  DEPLOY_ARTIFACT_VERSION,
  parseDeployArtifactEnvelope,
} from "./deploy-artifact.js"
import { ORGANISATION_DEPLOY_MANIFEST_VERSION } from "./organisation-deploy-manifest.js"

describe("deploy artifact envelope", () => {
  it("parses a versioned envelope with its producer", async () => {
    const parsed = await Effect.runPromise(
      parseDeployArtifactEnvelope({
        format: DEPLOY_ARTIFACT_FORMAT,
        version: DEPLOY_ARTIFACT_VERSION,
        orgPath: "examples/demo",
        producer: { name: "@processfocus/cli", version: "0.1.0-next.0" },
      }),
    )

    expect(parsed.orgPath).toBe("examples/demo")
    expect(parsed.producer?.name).toBe("@processfocus/cli")
  })

  it("fails with upgrade guidance for an unsupported version", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseDeployArtifactEnvelope({
          format: DEPLOY_ARTIFACT_FORMAT,
          version: 2,
          orgPath: "examples/demo",
        }),
      ),
    )

    expect(error).toBeInstanceOf(UnsupportedArtifactVersionError)
    if (!(error instanceof UnsupportedArtifactVersionError)) {
      throw error
    }
    expect(error.detectedVersion).toBe(2)
    expect(error.upgradeHint).toContain("Update @processfocus/runtime")
  })
})

describe("artifact inventory", () => {
  it("parses entries with format ownership and checksums", async () => {
    const parsed = await Effect.runPromise(
      parseArtifactInventory({
        format: "processfocus/artifact-inventory",
        version: 1,
        producer: { name: "@processfocus/cli", version: "0.1.0-next.0" },
        entries: [
          {
            format: "processfocus/deploy-manifest",
            version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
            path: "dist/deploy-manifest.json",
            sha256: "a".repeat(64),
          },
        ],
      }),
    )

    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.format).toBe("processfocus/deploy-manifest")
  })

  it("fails on a malformed checksum with a parse error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseArtifactInventory({
          format: "processfocus/artifact-inventory",
          version: 1,
          entries: [
            {
              format: "x",
              version: 0,
              path: "dist/org.js",
              sha256: "not-a-sha",
            },
          ],
        }),
      ),
    )

    expect(error).toBeInstanceOf(ArtifactInventoryParseError)
  })
})

describe("runtime artifact version error", () => {
  it("is shareable across artifact kinds", () => {
    expect(UnsupportedArtifactVersionError).toBeDefined()
    expect(parseRuntimeArtifact).toBeDefined()
  })
})
