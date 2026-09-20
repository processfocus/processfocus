"use client"

import { registerRendererPlugin } from "@pf/form/plugin-registry"
import {
  type FrontendPluginSessionConsumerProps,
  type OrganisationFrontendPlugin,
  type OrganisationFrontendPluginHost,
  activateOrganisationFrontendPlugin,
} from "@pf/frontend-plugin-host"
import { registerExecutionMenuAction } from "./execution-menu-actions-registry"
import { registerFrontendClientPlugin } from "./frontend-client-plugin-registry"
import type {
  FrontendManifestAnalyticsPlugin,
  FrontendManifestPlugins,
} from "./frontend-manifest"
import { GraphqlClientConsumer } from "./graphql/client-consumer"
import { useOptionalSession } from "@/components/auth-provider"
import { createOrganisationFrontendPluginLoaders } from "@/lib/organisation-plugin-loaders"

function PluginSessionConsumer({
  children,
}: FrontendPluginSessionConsumerProps) {
  const session = useOptionalSession()
  if (!session || !("email" in session)) {
    return children({})
  }
  return children({ email: session.email })
}

const organisationFrontendPluginHost = {
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register: registerFrontendClientPlugin },
  formRenderers: { register: registerRendererPlugin },
  executionMenu: { register: registerExecutionMenuAction },
  graphql: { ClientConsumer: GraphqlClientConsumer },
  session: { Consumer: PluginSessionConsumer },
} satisfies OrganisationFrontendPluginHost

export interface FrontendPluginLoader {
  (config?: unknown): Promise<boolean | undefined> | boolean | undefined
  readonly shouldActivate?: (config?: unknown) => Promise<boolean> | boolean
}
export type FrontendPluginLoaderMap = Readonly<
  Record<string, FrontendPluginLoader | undefined>
>

export interface FrontendPluginLoadFailure {
  readonly pluginType: string
  readonly cause: unknown
}

export type FrontendPluginLoadFailureObserver = (
  failure: FrontendPluginLoadFailure,
) => void

const loadedFrontendPluginTypes = new Set<string>()
const loadingFrontendPluginTypes = new Map<string, Promise<void>>()

export const activateOrganisationFrontendPluginForHost = async (
  manifestType: string,
  plugin: OrganisationFrontendPlugin,
): Promise<void> => {
  if (plugin.id !== manifestType) {
    throw new Error(
      `Organisation frontend plugin identity "${plugin.id}" does not match manifest type "${manifestType}"`,
    )
  }
  await activateOrganisationFrontendPlugin(
    plugin,
    organisationFrontendPluginHost,
  )
}

// Keys are the stable manifest `plugin.type` values emitted by org builds.
const frontendPluginLoaders = createOrganisationFrontendPluginLoaders({
  activate: activateOrganisationFrontendPluginForHost,
})

const ensureFrontendPluginTypeLoaded = async (
  type: string,
  loaders: FrontendPluginLoaderMap,
  config?: unknown,
): Promise<boolean> => {
  const loader = loaders[type]

  if (!loader) {
    throw new Error(
      `No organisation frontend plugin loader is registered for "${type}"`,
    )
  }

  if (loader.shouldActivate && !(await loader.shouldActivate(config))) {
    return false
  }

  if (loadedFrontendPluginTypes.has(type)) {
    return true
  }

  const existingLoad = loadingFrontendPluginTypes.get(type)

  if (existingLoad) {
    await existingLoad
    return loadedFrontendPluginTypes.has(type)
  }

  const load = Promise.resolve(loader(config)).then((activated) => {
    if (activated !== false) {
      loadedFrontendPluginTypes.add(type)
    }
  })

  loadingFrontendPluginTypes.set(type, load)

  try {
    await load
    return loadedFrontendPluginTypes.has(type)
  } finally {
    loadingFrontendPluginTypes.delete(type)
  }
}

const loadAnalyticsPlugin = async (
  plugin: FrontendManifestAnalyticsPlugin,
  loaders: FrontendPluginLoaderMap,
  onPluginFailure?: FrontendPluginLoadFailureObserver,
): Promise<FrontendManifestAnalyticsPlugin | undefined> => {
  try {
    return (await ensureFrontendPluginTypeLoaded(
      plugin.type,
      loaders,
      plugin.config,
    ))
      ? plugin
      : undefined
  } catch (error) {
    console.error(
      `[frontend-plugin-loaders] failed to load frontend plugin "${plugin.type}"`,
      error,
    )
    onPluginFailure?.({ pluginType: plugin.type, cause: error })
    return undefined
  }
}

const loadFormComponentPlugin = async (
  type: string,
  loaders: FrontendPluginLoaderMap,
  onPluginFailure?: FrontendPluginLoadFailureObserver,
): Promise<void> => {
  try {
    await ensureFrontendPluginTypeLoaded(type, loaders, undefined)
  } catch (error) {
    console.error(
      `[frontend-plugin-loaders] failed to load frontend plugin "${type}"`,
      error,
    )
    onPluginFailure?.({ pluginType: type, cause: error })
  }
}

export const loadFrontendManifestPlugins = async (
  plugins: FrontendManifestPlugins,
  loaders: FrontendPluginLoaderMap = frontendPluginLoaders,
  onPluginFailure?: FrontendPluginLoadFailureObserver,
): Promise<ReadonlyArray<FrontendManifestAnalyticsPlugin>> => {
  const loadedAnalyticsPlugins: FrontendManifestAnalyticsPlugin[] = []

  for (const plugin of plugins.analytics) {
    const loadedPlugin = await loadAnalyticsPlugin(
      plugin,
      loaders,
      onPluginFailure,
    )
    if (loadedPlugin) {
      loadedAnalyticsPlugins.push(loadedPlugin)
    }
  }

  for (const plugin of plugins.formComponents) {
    await loadFormComponentPlugin(plugin.type, loaders, onPluginFailure)
  }

  return loadedAnalyticsPlugins
}

export const clearFrontendPluginLoaderStateForTest = (): void => {
  loadedFrontendPluginTypes.clear()
  loadingFrontendPluginTypes.clear()
}
