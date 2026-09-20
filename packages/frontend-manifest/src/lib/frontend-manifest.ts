export type OrganisationFrontendPluginManifestJson =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<OrganisationFrontendPluginManifestJson>
  | {
      readonly [key: string]: OrganisationFrontendPluginManifestJson
    }

export interface OrganisationFrontendPluginManifestClientPlugin {
  readonly module: string
  readonly type: string
  readonly config: OrganisationFrontendPluginManifestJson
}

export interface OrganisationFrontendManifestFormComponentPluginDeclaration {
  readonly module: string
  readonly type: string
}

export interface OrganisationFrontendManifestAnalyticsPlugin
  extends OrganisationFrontendPluginManifestClientPlugin {}

export interface OrganisationFrontendManifestFormComponentPlugin
  extends OrganisationFrontendManifestFormComponentPluginDeclaration {}

export interface OrganisationFrontendManifestProcessDocumentation {
  readonly processPath: string
  readonly documentationPath: string
}

export interface OrganisationFrontendManifestMetadataIcon {
  readonly url: string
  readonly rel: string
  readonly type?: string | undefined
  readonly sizes?: string | undefined
}

export interface OrganisationFrontendManifestWebAppManifestIcon {
  readonly src: string
  readonly sizes: string
  readonly type?: string | undefined
  readonly purpose?: string | undefined
}

export interface OrganisationFrontendManifestAppIcons {
  readonly metadata: ReadonlyArray<OrganisationFrontendManifestMetadataIcon>
  readonly manifest: ReadonlyArray<OrganisationFrontendManifestWebAppManifestIcon>
}

export interface OrganisationFrontendManifestPublicFormBranding {
  readonly headerHtml?: string | undefined
  readonly footerHtml?: string | undefined
}

export interface OrganisationFrontendManifestClientFormDefinition {
  readonly components: Readonly<Record<string, unknown>>
  readonly rules: readonly unknown[]
}

export interface OrganisationFrontendManifestEmbedEntry {
  readonly stepPath: string
  readonly processName: string
  readonly processPath: string
  readonly mutationName: string
  readonly inputTypeName: string
  readonly totalFields: number
  readonly formDefinition: OrganisationFrontendManifestClientFormDefinition | null
  readonly defaultValues: Record<string, unknown> | null
  readonly jsonSchema: Record<string, unknown> | null
  readonly sites: readonly string[]
  readonly thankYou: string
}

export interface OrganisationFrontendManifest {
  readonly version: typeof ORGANISATION_FRONTEND_MANIFEST_VERSION
  readonly organisation: {
    readonly name: string
    readonly acronym?: string
  }
  readonly appIcons: OrganisationFrontendManifestAppIcons
  readonly publicFormBranding: OrganisationFrontendManifestPublicFormBranding | null
  readonly embed: {
    readonly entries: ReadonlyArray<OrganisationFrontendManifestEmbedEntry>
  }
  readonly processes: {
    readonly documentation: ReadonlyArray<OrganisationFrontendManifestProcessDocumentation>
  }
  readonly plugins: {
    readonly analytics: ReadonlyArray<OrganisationFrontendManifestAnalyticsPlugin>
    readonly formComponents: ReadonlyArray<OrganisationFrontendManifestFormComponentPlugin>
  }
}

export const ORGANISATION_FRONTEND_MANIFEST_FILE = "frontend-manifest.json"
export const ORGANISATION_FRONTEND_MANIFEST_VERSION = 3 as const

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  return value
}

const ensureString = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`)
  }

  return value
}

export const ensureNonEmptyString = (value: unknown, path: string): string => {
  const string = ensureString(value, path).trim()
  if (string.length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }

  return string
}

const ensureArray = (value: unknown, path: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`)
  }

  return value
}

const parseTransportFormDefinition = (
  value: unknown,
  path: string,
): OrganisationFrontendManifestClientFormDefinition | null => {
  if (value === null) return null

  const definition = ensureRecord(value, path)
  return {
    components: ensureRecord(definition["components"], `${path}.components`),
    rules: ensureArray(definition["rules"], `${path}.rules`),
  }
}

const ensureStringArray = (value: unknown, path: string): string[] => {
  const entries = ensureArray(value, path)
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`)
  }

  return entries.map((entry) => ensureString(entry, path))
}

export const ensureJsonValue = (
  value: unknown,
  path: string,
): OrganisationFrontendPluginManifestJson => {
  if (value === null) {
    return null
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      ensureJsonValue(entry, `${path}[${index}]`),
    )
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number`)
      }
      return value
    case "object": {
      const record = ensureRecord(value, path)
      const normalized: Record<string, OrganisationFrontendPluginManifestJson> =
        {}
      for (const [key, entry] of Object.entries(record)) {
        normalized[key] = ensureJsonValue(entry, `${path}.${key}`)
      }
      return normalized
    }
    default:
      throw new Error(`${path} must be JSON-serializable`)
  }
}

const parseOptionalString = (
  value: unknown,
  path: string,
): string | undefined =>
  value === undefined ? undefined : ensureNonEmptyString(value, path)

const parseOptionalHtmlString = (
  value: unknown,
  path: string,
): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

const normalizePath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`

const parseEmbedEntry = (
  value: unknown,
  path: string,
): OrganisationFrontendManifestEmbedEntry => {
  const entry = ensureRecord(value, path)
  const totalFields = entry["totalFields"]
  if (typeof totalFields !== "number") {
    throw new Error(`${path}.totalFields must be a number`)
  }

  const optionalRecord = (
    key: "defaultValues" | "jsonSchema",
  ): Record<string, unknown> | null =>
    entry[key] === null ? null : ensureRecord(entry[key], `${path}.${key}`)

  const formDefinition = parseTransportFormDefinition(
    entry["formDefinition"],
    `${path}.formDefinition`,
  )

  return {
    stepPath: ensureString(entry["stepPath"], `${path}.stepPath`),
    processName: ensureString(entry["processName"], `${path}.processName`),
    processPath: ensureString(entry["processPath"], `${path}.processPath`),
    mutationName: ensureString(entry["mutationName"], `${path}.mutationName`),
    inputTypeName: ensureString(
      entry["inputTypeName"],
      `${path}.inputTypeName`,
    ),
    totalFields,
    formDefinition,
    defaultValues: optionalRecord("defaultValues"),
    jsonSchema: optionalRecord("jsonSchema"),
    sites: ensureStringArray(entry["sites"], `${path}.sites`),
    thankYou: ensureString(entry["thankYou"], `${path}.thankYou`),
  }
}

const parseAppIcons = (
  value: unknown,
): OrganisationFrontendManifestAppIcons => {
  if (value === undefined) {
    return { metadata: [], manifest: [] }
  }
  const appIcons = ensureRecord(value, "appIcons")
  return {
    metadata: ensureArray(appIcons["metadata"], "appIcons.metadata").map(
      (value, index) => {
        const path = `appIcons.metadata[${index}]`
        const icon = ensureRecord(value, path)
        return {
          url: ensureNonEmptyString(icon["url"], `${path}.url`),
          rel: ensureNonEmptyString(icon["rel"], `${path}.rel`),
          type: parseOptionalString(icon["type"], `${path}.type`),
          sizes: parseOptionalString(icon["sizes"], `${path}.sizes`),
        }
      },
    ),
    manifest: ensureArray(appIcons["manifest"], "appIcons.manifest").map(
      (value, index) => {
        const path = `appIcons.manifest[${index}]`
        const icon = ensureRecord(value, path)
        return {
          src: ensureNonEmptyString(icon["src"], `${path}.src`),
          sizes: ensureNonEmptyString(icon["sizes"], `${path}.sizes`),
          type: parseOptionalString(icon["type"], `${path}.type`),
          purpose: parseOptionalString(icon["purpose"], `${path}.purpose`),
        }
      },
    ),
  }
}

const parsePublicFormBranding = (
  value: unknown,
): OrganisationFrontendManifestPublicFormBranding | null => {
  if (value === undefined || value === null) {
    return null
  }
  const branding = ensureRecord(value, "publicFormBranding")
  const headerHtml = parseOptionalHtmlString(
    branding["headerHtml"],
    "publicFormBranding.headerHtml",
  )
  const footerHtml = parseOptionalHtmlString(
    branding["footerHtml"],
    "publicFormBranding.footerHtml",
  )
  if (headerHtml === undefined && footerHtml === undefined) {
    throw new Error("publicFormBranding must declare headerHtml or footerHtml")
  }
  return {
    ...(headerHtml !== undefined ? { headerHtml } : {}),
    ...(footerHtml !== undefined ? { footerHtml } : {}),
  }
}

export const parseOrganisationFrontendManifest = (
  value: unknown,
): OrganisationFrontendManifest => {
  const record = ensureRecord(value, "organisation frontend manifest")
  if (record["version"] !== ORGANISATION_FRONTEND_MANIFEST_VERSION) {
    throw new Error(
      `organisation frontend manifest version must be ${String(ORGANISATION_FRONTEND_MANIFEST_VERSION)}, got ${String(record["version"])}`,
    )
  }

  const organisationValue = record["organisation"]
  const organisation =
    organisationValue === undefined
      ? { name: "Process Focus" }
      : (() => {
          const identity = ensureRecord(organisationValue, "organisation")
          const acronym = parseOptionalString(
            identity["acronym"],
            "organisation.acronym",
          )
          return {
            name: ensureNonEmptyString(identity["name"], "organisation.name"),
            ...(acronym !== undefined ? { acronym } : {}),
          }
        })()
  const embed = ensureRecord(record["embed"], "embed")
  const plugins = ensureRecord(record["plugins"], "plugins")
  const processesValue = record["processes"]
  const processes =
    processesValue === undefined
      ? { documentation: [] }
      : (() => {
          const processRecord = ensureRecord(processesValue, "processes")
          return {
            documentation: ensureArray(
              processRecord["documentation"],
              "processes.documentation",
            ).map((value, index) => {
              const path = `processes.documentation[${index}]`
              const documentation = ensureRecord(value, path)
              return {
                processPath: normalizePath(
                  ensureNonEmptyString(
                    documentation["processPath"],
                    `${path}.processPath`,
                  ),
                ),
                documentationPath: ensureNonEmptyString(
                  documentation["documentationPath"],
                  `${path}.documentationPath`,
                ),
              }
            }),
          }
        })()

  return {
    version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
    organisation,
    appIcons: parseAppIcons(record["appIcons"]),
    publicFormBranding: parsePublicFormBranding(record["publicFormBranding"]),
    embed: {
      entries: ensureArray(embed["entries"], "embed.entries").map(
        (value, index) => parseEmbedEntry(value, `embed.entries[${index}]`),
      ),
    },
    processes,
    plugins: {
      analytics: ensureArray(plugins["analytics"], "plugins.analytics").map(
        (value, index) => {
          const path = `plugins.analytics[${index}]`
          const plugin = ensureRecord(value, path)
          return {
            module: ensureNonEmptyString(plugin["module"], `${path}.module`),
            type: ensureNonEmptyString(plugin["type"], `${path}.type`),
            config: ensureJsonValue(plugin["config"], `${path}.config`),
          }
        },
      ),
      formComponents: ensureArray(
        plugins["formComponents"],
        "plugins.formComponents",
      ).map((value, index) => {
        const path = `plugins.formComponents[${index}]`
        const plugin = ensureRecord(value, path)
        return {
          module: ensureNonEmptyString(plugin["module"], `${path}.module`),
          type: ensureNonEmptyString(plugin["type"], `${path}.type`),
        }
      }),
    },
  }
}
