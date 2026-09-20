import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  RUNTIME_ARTIFACT_FORMAT,
  RUNTIME_ARTIFACT_VERSION,
  UnsupportedArtifactVersionError,
  parseRuntimeArtifact,
} from "./artifact.js"

const artifact = {
  format: RUNTIME_ARTIFACT_FORMAT,
  version: RUNTIME_ARTIFACT_VERSION,
  organisation: {},
}

describe("runtime artifact", () => {
  it("preserves provider-neutral namespaced extensions", async () => {
    const parsed = await Effect.runPromise(
      parseRuntimeArtifact({
        ...artifact,
        extensions: { "example/plugin": { enabled: true } },
      }),
    )

    expect(parsed.extensions).toEqual({
      "example/plugin": { enabled: true },
    })
  })

  it("rejects extension keys without a namespace", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseRuntimeArtifact({
          ...artifact,
          extensions: { plugin: { enabled: true } },
        }),
      ),
    )

    expect(error.message).toBe("Artifact extension keys must be namespaced")
  })

  it("preserves the producer identity when present", async () => {
    const parsed = await Effect.runPromise(
      parseRuntimeArtifact({
        ...artifact,
        producer: { name: "@processfocus/cli", version: "0.1.0-next.0" },
      }),
    )

    expect(parsed.producer).toEqual({
      name: "@processfocus/cli",
      version: "0.1.0-next.0",
    })
  })

  it("fails with an actionable unsupported-version error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseRuntimeArtifact({
          ...artifact,
          version: 2,
        }),
      ),
    )

    expect(error).toBeInstanceOf(UnsupportedArtifactVersionError)
    if (!(error instanceof UnsupportedArtifactVersionError)) {
      throw error
    }
    expect(error.detectedVersion).toBe(2)
    expect(error.supportedVersion).toBe(RUNTIME_ARTIFACT_VERSION)
    expect(error.upgradeHint).toContain("Update @processfocus/runtime")
  })
})
