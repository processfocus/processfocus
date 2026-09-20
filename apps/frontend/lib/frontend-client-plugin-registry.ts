"use client"

import {
  type FrontendClientPluginRegistration,
  type RegistrationDisposer,
  createRegistrationRegistry,
} from "@pf/frontend-plugin-host"

export type {
  FrontendClientPluginGraphqlRequestError,
  FrontendClientPluginRegistration,
} from "@pf/frontend-plugin-host"

const frontendClientPlugins =
  createRegistrationRegistry<FrontendClientPluginRegistration>(
    (plugin) => plugin.type,
  )

export const registerFrontendClientPlugin = (
  plugin: FrontendClientPluginRegistration,
): RegistrationDisposer => frontendClientPlugins.register(plugin)

export const getFrontendClientPlugin = (
  type: string,
): FrontendClientPluginRegistration | undefined =>
  frontendClientPlugins.get(type)

export const resetFrontendClientPluginIdentity = (
  onFailure?: (cause: unknown, pluginType: string) => void,
): void =>
  frontendClientPlugins.list().forEach((plugin) => {
    try {
      plugin.resetIdentity?.()
    } catch (cause) {
      try {
        onFailure?.(cause, plugin.type)
      } catch {
        // Failure observers must not prevent the remaining identity resets.
      }
    }
  })

export const clearFrontendClientPlugins = (): void => {
  frontendClientPlugins.reset()
}
