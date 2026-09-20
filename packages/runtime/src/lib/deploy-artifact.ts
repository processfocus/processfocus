import { Data, Effect } from "effect"
import {
  type ArtifactProducer,
  UNSUPPORTED_ARTIFACT_UPGRADE_HINT,
  UnsupportedArtifactVersionError,
  parseArtifactProducer,
} from "./artifact.js"

/**
 * The deployment-upload envelope (`.pf-deploy.json`) that travels inside the
 * deploy zip. It describes, in a provider-neutral way, where the built
 * organisation bundle and its manifests live inside the artifact.
 */
export const DEPLOY_ARTIFACT_FORMAT = "processfocus/deploy-artifact"
export const DEPLOY_ARTIFACT_VERSION = 1
export const DEPLOY_ARTIFACT_FILENAME = ".pf-deploy.json"

export interface DeployArtifactEnvelope {
  readonly format: typeof DEPLOY_ARTIFACT_FORMAT
  readonly version: typeof DEPLOY_ARTIFACT_VERSION
  readonly orgPath: string
  readonly producer?: ArtifactProducer | undefined
}

export class DeployArtifactParseError extends Data.TaggedError(
  "DeployArtifactParseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseDeployArtifactEnvelope = (
  value: unknown,
): Effect.Effect<
  DeployArtifactEnvelope,
  DeployArtifactParseError | UnsupportedArtifactVersionError
> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new DeployArtifactParseError({
        message: "Deploy artifact envelope must be an object",
      })
    }

    const format = value["format"]
    const version = value["version"]
    if (
      format !== DEPLOY_ARTIFACT_FORMAT ||
      version !== DEPLOY_ARTIFACT_VERSION
    ) {
      return yield* new UnsupportedArtifactVersionError({
        message: `Unsupported deploy artifact envelope ${JSON.stringify(format)}@${JSON.stringify(version)}; this runtime supports ${DEPLOY_ARTIFACT_FORMAT}@${DEPLOY_ARTIFACT_VERSION}.`,
        detectedFormat: format,
        detectedVersion: version,
        supportedFormat: DEPLOY_ARTIFACT_FORMAT,
        supportedVersion: DEPLOY_ARTIFACT_VERSION,
        upgradeHint: UNSUPPORTED_ARTIFACT_UPGRADE_HINT,
      })
    }

    const orgPath = value["orgPath"]
    if (typeof orgPath !== "string" || orgPath.length === 0) {
      return yield* new DeployArtifactParseError({
        message: "Deploy artifact envelope orgPath must be a non-empty string",
      })
    }

    let producer: ArtifactProducer | undefined
    try {
      producer = parseArtifactProducer(value["producer"])
    } catch (error) {
      return yield* new DeployArtifactParseError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })
    }

    return {
      format: DEPLOY_ARTIFACT_FORMAT,
      version: DEPLOY_ARTIFACT_VERSION,
      orgPath,
      ...(producer !== undefined ? { producer } : {}),
    }
  })
