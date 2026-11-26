import type {
  EmbedLookupDefinition,
  OrganisationFrontendManifestEmbedEntry,
} from "@pf/frontend-manifest"
export type EmbedManifestEntry = OrganisationFrontendManifestEmbedEntry

export const EMBED_EVENT_SOURCE = "processfocus-embed"
export const EMBED_EVENT_VERSION = 1

export type EmbedHostEventType = "ready" | "resize" | "submitted"

export interface EmbedHostEvent {
  readonly source: typeof EMBED_EVENT_SOURCE
  readonly version: typeof EMBED_EVENT_VERSION
  readonly event: EmbedHostEventType
  readonly stepPath: string
  readonly height?: number
}

export const findEmbedLookupDefinitionByField = (
  lookups: readonly EmbedLookupDefinition[],
  field: string,
): EmbedLookupDefinition | undefined =>
  lookups.find(
    (lookup) => !lookup.queryName && lookup.normalizedField === field,
  )

export const findEmbedLookupDefinitionByQueryName = (
  lookups: readonly EmbedLookupDefinition[],
  queryName: string,
): EmbedLookupDefinition | undefined =>
  lookups.find((lookup) => lookup.queryName === queryName)

const decodeEmbedSegments = (segments: readonly string[]): string[] =>
  segments.map(decodeURIComponent)

export const stepPathFromEmbedSegments = (
  segments: readonly string[],
): string => `/${decodeEmbedSegments(segments).join("/")}`

export const embedSegmentsFromStepPath = (stepPath: string): string[] =>
  stepPath.split("/").filter((segment) => segment.length > 0)

export const findEmbedManifestEntryForPath = (
  entries: readonly EmbedManifestEntry[],
  path: string,
): EmbedManifestEntry | undefined =>
  entries.find((entry) => entry.stepPath === path) ??
  entries.find((entry) => entry.processPath === path)

export const getEmbedRoutePath = (path: string): string =>
  `/embed/${embedSegmentsFromStepPath(path).map(encodeURIComponent).join("/")}`

export const buildEmbedFrameAncestorsPolicy = (
  entry: EmbedManifestEntry,
): string => `frame-ancestors ${["'self'", ...entry.sites].join(" ")}`

export const buildEmbedStorageKey = (stepPath: string): string =>
  `pf-embed:${stepPath}`
