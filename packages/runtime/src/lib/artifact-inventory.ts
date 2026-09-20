import { Data, Effect } from "effect"
import {
  type ArtifactProducer,
  UNSUPPORTED_ARTIFACT_UPGRADE_HINT,
  UnsupportedArtifactVersionError,
  parseArtifactProducer,
} from "./artifact.js"

/**
 * A versioned inventory of every artifact a build produces, with explicit
 * format ownership, version, and checksum per entry. This is the machine-readable
 * "organisation artifact metadata" a deploy pipeline validates against before
 * trusting the rest of the bundle.
 */
export const ARTIFACT_INVENTORY_FORMAT = "processfocus/artifact-inventory"
export const ARTIFACT_INVENTORY_VERSION = 1
export const ARTIFACT_INVENTORY_FILENAME = "artifacts.json"

export interface ArtifactInventoryEntry {
  readonly format: string
  readonly version: number
  readonly path: string
  readonly sha256: string
}

export interface ArtifactInventory {
  readonly format: typeof ARTIFACT_INVENTORY_FORMAT
  readonly version: typeof ARTIFACT_INVENTORY_VERSION
  readonly producer?: ArtifactProducer | undefined
  readonly entries: ReadonlyArray<ArtifactInventoryEntry>
}

export class ArtifactInventoryParseError extends Data.TaggedError(
  "ArtifactInventoryParseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)

const parseEntry = (value: unknown, path: string): ArtifactInventoryEntry => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  const format = value["format"]
  if (typeof format !== "string" || format.length === 0) {
    throw new Error(`${path}.format must be a non-empty string`)
  }

  const version = value["version"]
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    throw new Error(`${path}.version must be a non-negative integer`)
  }

  const entryPath = value["path"]
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw new Error(`${path}.path must be a non-empty string`)
  }

  if (!isSha256Hex(value["sha256"])) {
    throw new Error(`${path}.sha256 must be a 64-character hex string`)
  }

  return {
    format,
    version,
    path: entryPath,
    sha256: value["sha256"],
  }
}

export const parseArtifactInventory = (
  value: unknown,
): Effect.Effect<
  ArtifactInventory,
  ArtifactInventoryParseError | UnsupportedArtifactVersionError
> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new ArtifactInventoryParseError({
        message: "Artifact inventory must be an object",
      })
    }

    const format = value["format"]
    const version = value["version"]
    if (
      format !== ARTIFACT_INVENTORY_FORMAT ||
      version !== ARTIFACT_INVENTORY_VERSION
    ) {
      return yield* new UnsupportedArtifactVersionError({
        message: `Unsupported artifact inventory ${JSON.stringify(format)}@${JSON.stringify(version)}; this runtime supports ${ARTIFACT_INVENTORY_FORMAT}@${ARTIFACT_INVENTORY_VERSION}.`,
        detectedFormat: format,
        detectedVersion: version,
        supportedFormat: ARTIFACT_INVENTORY_FORMAT,
        supportedVersion: ARTIFACT_INVENTORY_VERSION,
        upgradeHint: UNSUPPORTED_ARTIFACT_UPGRADE_HINT,
      })
    }

    const entriesValue = value["entries"]
    if (!Array.isArray(entriesValue)) {
      return yield* new ArtifactInventoryParseError({
        message: "Artifact inventory entries must be an array",
      })
    }

    let producer: ArtifactProducer | undefined
    try {
      producer = parseArtifactProducer(value["producer"])
    } catch (error) {
      return yield* new ArtifactInventoryParseError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })
    }

    let entries: ArtifactInventoryEntry[]
    try {
      entries = entriesValue.map((entry, index) =>
        parseEntry(entry, `entries[${index}]`),
      )
    } catch (error) {
      return yield* new ArtifactInventoryParseError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })
    }

    return {
      format: ARTIFACT_INVENTORY_FORMAT,
      version: ARTIFACT_INVENTORY_VERSION,
      ...(producer !== undefined ? { producer } : {}),
      entries,
    }
  })
