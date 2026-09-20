import { Data, Effect } from "effect"

export const RUNTIME_ARTIFACT_FORMAT = "processfocus/runtime-artifact"
export const RUNTIME_ARTIFACT_VERSION = 1

/**
 * Identity of the producer that wrote an artifact. Version ownership lets a
 * reader fail with actionable upgrade guidance rather than silently misreading
 * a newer producer's shape.
 */
export interface ArtifactProducer {
  readonly name: string
  readonly version: string
}

export interface RuntimeArtifactEnvelope {
  readonly format: typeof RUNTIME_ARTIFACT_FORMAT
  readonly version: typeof RUNTIME_ARTIFACT_VERSION
  readonly organisation: unknown
  readonly producer?: ArtifactProducer | undefined
  readonly extensions: Readonly<Record<string, unknown>>
}

export class ArtifactParseError extends Data.TaggedError("ArtifactParseError")<{
  readonly message: string
}> {}

/**
 * Raised when an artifact declares a format or version this runtime does not
 * implement. Carries the exact detected/supported values and an actionable
 * upgrade hint so a reader can refuse -- before any mutation -- rather than
 * guessing at a newer producer's shape.
 */
export class UnsupportedArtifactVersionError extends Data.TaggedError(
  "UnsupportedArtifactVersionError",
)<{
  readonly message: string
  readonly detectedFormat: unknown
  readonly detectedVersion: unknown
  readonly supportedFormat: string
  readonly supportedVersion: number
  readonly upgradeHint: string
}> {}

export const UNSUPPORTED_ARTIFACT_UPGRADE_HINT =
  "Update @processfocus/runtime (or rebuild the organisation artifact with a newer producer) so their artifact format and version match."

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNamespacedExtension = (key: string): boolean =>
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(
    key,
  )

/**
 * Parse an optional producer identity, throwing the shared producer error on a
 * malformed value. Reused by the runtime-artifact, deploy-artifact envelope,
 * and artifact-inventory parsers so the shape is defined in one place.
 */
export const parseArtifactProducer = (
  value: unknown,
): ArtifactProducer | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!isRecord(value)) {
    throw new Error("producer must be an object")
  }

  const name = value["name"]
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("producer.name must be a non-empty string")
  }

  const version = value["version"]
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("producer.version must be a non-empty string")
  }

  return { name, version }
}

export const parseRuntimeArtifact = (
  value: unknown,
): Effect.Effect<
  RuntimeArtifactEnvelope,
  ArtifactParseError | UnsupportedArtifactVersionError
> => {
  if (!isRecord(value)) {
    return Effect.fail(
      new ArtifactParseError({ message: "Runtime artifact must be an object" }),
    )
  }

  const format = value["format"]
  const version = value["version"]
  if (
    format !== RUNTIME_ARTIFACT_FORMAT ||
    version !== RUNTIME_ARTIFACT_VERSION
  ) {
    return Effect.fail(
      new UnsupportedArtifactVersionError({
        message: `Unsupported runtime artifact format/version ${JSON.stringify(format)}@${JSON.stringify(version)}; this runtime supports ${RUNTIME_ARTIFACT_FORMAT}@${RUNTIME_ARTIFACT_VERSION}.`,
        detectedFormat: format,
        detectedVersion: version,
        supportedFormat: RUNTIME_ARTIFACT_FORMAT,
        supportedVersion: RUNTIME_ARTIFACT_VERSION,
        upgradeHint: UNSUPPORTED_ARTIFACT_UPGRADE_HINT,
      }),
    )
  }

  if (!isRecord(value["organisation"])) {
    return Effect.fail(
      new ArtifactParseError({
        message: "Runtime artifact has no organisation",
      }),
    )
  }

  const extensions = value["extensions"]
  if (extensions !== undefined && !isRecord(extensions)) {
    return Effect.fail(
      new ArtifactParseError({
        message: "Artifact extensions must be an object",
      }),
    )
  }
  if (
    extensions !== undefined &&
    Object.keys(extensions).some((key) => !isNamespacedExtension(key))
  ) {
    return Effect.fail(
      new ArtifactParseError({
        message: "Artifact extension keys must be namespaced",
      }),
    )
  }

  let producer: ArtifactProducer | undefined
  try {
    producer = parseArtifactProducer(value["producer"])
  } catch (error) {
    return Effect.fail(
      new ArtifactParseError({
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  return Effect.succeed({
    format: RUNTIME_ARTIFACT_FORMAT,
    version: RUNTIME_ARTIFACT_VERSION,
    organisation: value["organisation"],
    ...(producer !== undefined ? { producer } : {}),
    extensions: extensions ?? {},
  })
}
