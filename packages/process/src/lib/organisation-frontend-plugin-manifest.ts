import type { IConstruct } from "constructs"
import {
  BROWSER_PLUGIN_CATEGORIES,
  type BrowserPluginCategory,
  type OrganisationFrontendPluginManifestClientPlugin,
  ensureJsonValue,
  ensureNonEmptyString,
  ensureRecord,
  isBrowserPluginCategory,
} from "@pf/frontend-manifest"
import type { Organisation } from "./organisation"

export type {
  BrowserPluginArtifactEntry,
  BrowserPluginArtifactManifest,
  BrowserPluginCategory,
  OrganisationFrontendPluginManifestClientPlugin,
  OrganisationFrontendPluginManifestJson,
} from "@pf/frontend-manifest"
export {
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FILE,
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_FORMAT,
  BROWSER_PLUGIN_ARTIFACT_MANIFEST_VERSION,
  parseBrowserPluginArtifactManifest,
} from "@pf/frontend-manifest"

/** Categorizes how the Dashboard activates a browser plugin. */
export type OrganisationFrontendManifestPluginCategory = BrowserPluginCategory

export interface OrganisationFrontendPluginManifestProvider {
  readonly isFrontendClientPluginManifestProvider: true
  readonly frontendManifestPluginCategory?: OrganisationFrontendManifestPluginCategory
  buildFrontendClientPluginManifest(): OrganisationFrontendPluginManifestClientPlugin
}

export interface OrganisationBrowserPluginBuildInput {
  readonly identity: string
  readonly category: BrowserPluginCategory
  readonly hostInterfaceVersion: number
  readonly entrypoint: string
  readonly preparation?: OrganisationBrowserPluginPreparationBuildInput
}

export interface OrganisationBrowserPluginPreparationBuildInput {
  readonly kind: "stylesheet"
  readonly entrypoint: string
}

export interface OrganisationBrowserPluginArtifactProvider {
  readonly isBrowserPluginArtifactProvider: true
  buildBrowserPluginArtifact(): OrganisationBrowserPluginBuildInput
}

type OrganisationFrontendPluginManifestConstruct = IConstruct &
  OrganisationFrontendPluginManifestProvider

type OrganisationBrowserPluginArtifactConstruct = IConstruct &
  OrganisationFrontendPluginManifestProvider &
  OrganisationBrowserPluginArtifactProvider

const parseClientPlugin = (
  value: unknown,
  path: string,
): OrganisationFrontendPluginManifestClientPlugin => {
  const record = ensureRecord(value, path)

  return {
    module: ensureNonEmptyString(record["module"], `${path}.module`),
    type: ensureNonEmptyString(record["type"], `${path}.type`),
    config: ensureJsonValue(record["config"], `${path}.config`),
  }
}

const isFrontendPluginManifestProvider = (
  construct: IConstruct,
): construct is OrganisationFrontendPluginManifestConstruct => {
  const casted = construct as {
    readonly isFrontendClientPluginManifestProvider?: unknown
  }

  return casted.isFrontendClientPluginManifestProvider === true
}

export const findOrganisationFrontendPluginManifestProviders = (
  org: Organisation,
): ReadonlyArray<OrganisationFrontendPluginManifestConstruct> =>
  org.node.findAll().filter(isFrontendPluginManifestProvider)

const isBrowserPluginArtifactProvider = (
  construct: IConstruct,
): construct is OrganisationBrowserPluginArtifactConstruct => {
  const candidate = construct as {
    readonly isBrowserPluginArtifactProvider?: unknown
    readonly isFrontendClientPluginManifestProvider?: unknown
  }
  return (
    candidate.isBrowserPluginArtifactProvider === true &&
    candidate.isFrontendClientPluginManifestProvider === true
  )
}

export const findOrganisationBrowserPluginArtifactProviders = (
  org: Organisation,
): ReadonlyArray<OrganisationBrowserPluginArtifactConstruct> =>
  org.node.findAll().filter(isBrowserPluginArtifactProvider)

export const buildOrganisationBrowserPluginBuildInput = (
  provider: OrganisationBrowserPluginArtifactConstruct,
): OrganisationBrowserPluginBuildInput => {
  const candidate = provider as {
    readonly buildBrowserPluginArtifact?: unknown
  }
  if (typeof candidate.buildBrowserPluginArtifact !== "function") {
    throw new Error(
      `${provider.node.path} must expose buildBrowserPluginArtifact()`,
    )
  }

  const value: unknown = candidate.buildBrowserPluginArtifact.call(provider)
  const record = ensureRecord(
    value,
    `${provider.node.path} browser plugin artifact`,
  )
  const category = record["category"]
  if (!isBrowserPluginCategory(category)) {
    const allowedCategories = BROWSER_PLUGIN_CATEGORIES.map((allowedCategory) =>
      JSON.stringify(allowedCategory),
    ).join(" or ")
    throw new Error(
      `${provider.node.path} browser plugin artifact.category must be ${allowedCategories}`,
    )
  }
  const hostInterfaceVersion = record["hostInterfaceVersion"]
  if (
    typeof hostInterfaceVersion !== "number" ||
    !Number.isInteger(hostInterfaceVersion) ||
    hostInterfaceVersion < 1
  ) {
    throw new Error(
      `${provider.node.path} browser plugin artifact.hostInterfaceVersion must be a positive integer`,
    )
  }
  const preparationValue = record["preparation"]
  let preparation: OrganisationBrowserPluginPreparationBuildInput | undefined
  if (preparationValue !== undefined) {
    const preparationRecord = ensureRecord(
      preparationValue,
      `${provider.node.path} browser plugin artifact.preparation`,
    )
    if (preparationRecord["kind"] !== "stylesheet") {
      throw new Error(
        `${provider.node.path} browser plugin artifact.preparation.kind must be "stylesheet"`,
      )
    }
    preparation = {
      kind: "stylesheet",
      entrypoint: ensureNonEmptyString(
        preparationRecord["entrypoint"],
        `${provider.node.path} browser plugin artifact.preparation.entrypoint`,
      ),
    }
  }

  return {
    identity: ensureNonEmptyString(
      record["identity"],
      `${provider.node.path} browser plugin artifact.identity`,
    ),
    category,
    hostInterfaceVersion,
    entrypoint: ensureNonEmptyString(
      record["entrypoint"],
      `${provider.node.path} browser plugin artifact.entrypoint`,
    ),
    ...(preparation !== undefined && { preparation }),
  }
}

export const buildOrganisationFrontendPluginManifestClientPlugin = (
  provider: OrganisationFrontendPluginManifestConstruct,
): OrganisationFrontendPluginManifestClientPlugin => {
  const casted = provider as {
    readonly buildFrontendClientPluginManifest?: unknown
    readonly node?: { readonly path?: unknown }
  }

  if (typeof casted.buildFrontendClientPluginManifest !== "function") {
    throw new Error(
      `${provider.node.path} must expose buildFrontendClientPluginManifest()`,
    )
  }

  return parseClientPlugin(
    casted.buildFrontendClientPluginManifest.call(provider),
    `${provider.node.path} frontend client plugin`,
  )
}
