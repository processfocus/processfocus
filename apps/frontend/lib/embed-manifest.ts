import type { ClientFormDefinition } from "@pf/form-client-representation/client-form-definition"
import {
  type FormComponent,
  FormComponentType,
} from "@pf/form-client-representation/types"

export interface EmbedManifestEntry {
  readonly stepPath: string
  readonly processName: string
  readonly processPath: string
  readonly mutationName: string
  readonly inputTypeName: string
  readonly totalFields: number
  readonly formDefinition: ClientFormDefinition | null
  readonly defaultValues: Record<string, unknown> | null
  readonly jsonSchema: Record<string, unknown> | null
  readonly sites: readonly string[]
  readonly thankYou: string
}

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

interface EmbedLookupDefinition {
  readonly type: FormComponentType.Lookup | FormComponentType.CalendarSlot
  readonly field: string
  readonly normalizedField: string
  readonly dependencies: readonly string[]
  readonly queryName?: string
}

// Generic lookup queries receive the leaf field name, so nested field paths are
// normalized to their last segment before checking the embed manifest allowlist.
const normalizeEmbedLookupFieldName = (field: string): string =>
  field.split(".").pop() ?? field

const collectEmbedLookupDefinitionsFromComponent = (
  component: FormComponent,
): EmbedLookupDefinition[] => {
  if (component._tag === FormComponentType.Lookup) {
    return [
      {
        type: FormComponentType.Lookup,
        field: component.field,
        normalizedField: normalizeEmbedLookupFieldName(component.field),
        dependencies: component.dependencies ?? [],
        ...(component.queryName && {
          queryName: component.queryName,
        }),
      },
    ]
  }

  if (component._tag === FormComponentType.CalendarSlot) {
    return [
      {
        type: FormComponentType.CalendarSlot,
        field: component.field,
        normalizedField: normalizeEmbedLookupFieldName(component.field),
        dependencies: [],
      },
    ]
  }

  if (component._tag === FormComponentType.FieldSet) {
    return Object.values(component.children).flatMap(
      collectEmbedLookupDefinitionsFromComponent,
    )
  }

  if (
    component._tag === FormComponentType.List ||
    component._tag === FormComponentType.Table
  ) {
    return Object.values(component.itemChildren).flatMap(
      collectEmbedLookupDefinitionsFromComponent,
    )
  }

  return []
}

export const collectEmbedLookupDefinitions = (
  formDefinition: ClientFormDefinition | null,
): readonly EmbedLookupDefinition[] => {
  if (!formDefinition) {
    return []
  }

  return Object.values(formDefinition.components).flatMap(
    collectEmbedLookupDefinitionsFromComponent,
  )
}

export const findEmbedLookupDefinitionByField = (
  formDefinition: ClientFormDefinition | null,
  field: string,
): EmbedLookupDefinition | undefined =>
  collectEmbedLookupDefinitions(formDefinition).find(
    // Dependent lookups must go through their typed queryName path so callers
    // cannot hit them through the generic field-based lookup endpoint.
    (lookup) =>
      !lookup.queryName &&
      lookup.normalizedField === field &&
      (lookup.type === FormComponentType.Lookup ||
        lookup.type === FormComponentType.CalendarSlot),
  )

export const findEmbedLookupDefinitionByQueryName = (
  formDefinition: ClientFormDefinition | null,
  queryName: string,
): EmbedLookupDefinition | undefined =>
  collectEmbedLookupDefinitions(formDefinition).find(
    (lookup) => lookup.queryName === queryName,
  )

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
