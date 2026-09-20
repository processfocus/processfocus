/**
 * Renderer plugin registry for dynamic form component types.
 *
 * Plugins register React renderers here at app startup so the form
 * walker can render PluginField components.
 */

import {
  type FormRenderer,
  type FormRendererRegistration,
  type RegistrationDisposer,
  createRegistrationRegistry,
} from "@pf/frontend-plugin-host"

export type {
  FormRenderer as PluginRenderer,
  FormRendererOptions as PluginRendererOptions,
  FormRendererRegistration as RendererPluginRegistration,
} from "@pf/frontend-plugin-host"

const rendererPlugins = createRegistrationRegistry<FormRendererRegistration>(
  (registration) => registration.type,
)

export const registerRendererPlugin = (
  registration: FormRendererRegistration,
): RegistrationDisposer => rendererPlugins.register(registration)

export const getPluginRenderer = (type: string): FormRenderer | undefined =>
  rendererPlugins.get(type)?.renderer

export const clearRendererPlugins = (): void => {
  rendererPlugins.reset()
}
