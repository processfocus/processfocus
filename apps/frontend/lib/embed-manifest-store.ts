import {
  type EmbedManifestEntry,
  findEmbedManifestEntryForPath,
} from "./embed-manifest"
import { getFrontendManifest } from "./frontend-manifest-store"

export const getEmbedManifestEntries = (): readonly EmbedManifestEntry[] =>
  getFrontendManifest().embed.entries

export const getEmbedManifestEntry = (
  stepPath: string,
): EmbedManifestEntry | undefined =>
  getFrontendManifest().embed.entries.find(
    (entry) => entry.stepPath === stepPath,
  )

export const getEmbedManifestEntryForPath = (
  path: string,
): EmbedManifestEntry | undefined =>
  findEmbedManifestEntryForPath(getFrontendManifest().embed.entries, path)
