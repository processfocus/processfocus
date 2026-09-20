import type { ComponentType, JSX, ReactNode } from "react"

export const FRONTEND_PLUGIN_HOST_INTERFACE_VERSION = 1 as const

export interface GraphqlRequester {
  readonly request: <TData>(
    document: string,
    variables?: Record<string, unknown>,
  ) => Promise<TData>
}

export interface GraphqlClientConsumerProps {
  readonly children: (graphqlClient: GraphqlRequester) => ReactNode
}

export interface FrontendPluginSession {
  readonly email?: string
}

export interface FrontendPluginSessionConsumerProps {
  readonly children: (session: FrontendPluginSession) => ReactNode
}

export interface FrontendClientPluginGraphqlRequestError {
  readonly operationName: string
  readonly pathname: string | null
  readonly responseStatus: number | null
  readonly graphqlErrors: ReadonlyArray<{
    readonly code: string | null
    readonly message: string
    readonly path: string | null
  }>
}

export interface FrontendClientPluginIdentity {
  readonly email?: string
  readonly name?: string
  readonly userId: string
  readonly username: string
}

export interface FrontendClientPluginRegistration {
  readonly type: string
  readonly captureClientException?: (
    config: unknown,
    error: Error,
    properties?: Record<string, unknown>,
  ) => void
  readonly captureGraphqlRequestError?: (
    config: unknown,
    error: Error,
    details: FrontendClientPluginGraphqlRequestError,
  ) => void
  readonly renderIdentify?: (
    config: unknown,
    identity: FrontendClientPluginIdentity,
  ) => ReactNode
  readonly resetIdentity?: () => void
  readonly render: (config: unknown) => ReactNode
}

export interface FrontendPluginField {
  readonly _tag: "plugin"
  readonly field: string
  readonly label: string
  readonly description?: string
  readonly readonly?: boolean
  readonly disabled?: boolean
  readonly hidden?: boolean
  readonly required?: boolean
  readonly autoComplete?: string
  readonly pluginType: string
  readonly pluginData?: unknown
}

export interface FrontendPluginForm {
  readonly AppField: ComponentType<{
    readonly name: string
    readonly children: () => JSX.Element
  }>
}

export interface FormRendererOptions {
  readonly todoId?: string
  readonly stepPath?: string
}

export type FormRenderer = (
  form: FrontendPluginForm,
  component: FrontendPluginField,
  shouldAutoFocus: boolean,
  options?: FormRendererOptions,
) => JSX.Element

export interface FormRendererRegistration {
  readonly type: string
  readonly renderer: FormRenderer
}

export interface ExecutionMenuActionVisibilityContext {
  readonly executionId: string
  readonly processPath: string
  readonly status: string
  readonly showProcessState: boolean
}

export interface ExecutionMenuActionSelectContext
  extends ExecutionMenuActionVisibilityContext {
  readonly request: GraphqlRequester["request"]
}

export interface ExecutionMenuActionRegistration {
  readonly id: string
  readonly label: string
  readonly busyLabel?: string
  readonly isVisible: (context: ExecutionMenuActionVisibilityContext) => boolean
  readonly onSelect: (
    context: ExecutionMenuActionSelectContext,
  ) => Promise<void>
}

export type RegistrationDisposer = () => void

/** Versioned browser capabilities supplied to organisation plugins. */
export interface OrganisationFrontendPluginHost {
  readonly kind: "organisation-plugin-host"
  readonly interfaceVersion: typeof FRONTEND_PLUGIN_HOST_INTERFACE_VERSION
  readonly analytics: {
    readonly register: (
      plugin: FrontendClientPluginRegistration,
    ) => RegistrationDisposer
  }
  readonly formRenderers: {
    readonly register: (
      renderer: FormRendererRegistration,
    ) => RegistrationDisposer
  }
  readonly executionMenu: {
    readonly register: (
      action: ExecutionMenuActionRegistration,
    ) => RegistrationDisposer
  }
  readonly graphql: {
    readonly ClientConsumer: ComponentType<GraphqlClientConsumerProps>
  }
  readonly session?: {
    readonly Consumer: ComponentType<FrontendPluginSessionConsumerProps>
  }
}

export interface OrganisationFrontendPlugin {
  readonly id: string
  readonly activate: (
    host: OrganisationFrontendPluginHost,
  ) => Promise<void> | void
}

export interface OrganisationFrontendPluginFailure {
  readonly pluginId: string
  readonly cause: unknown
}

export interface RegistrationRegistry<T> {
  readonly register: (registration: T) => RegistrationDisposer
  readonly get: (key: string) => T | undefined
  readonly list: () => readonly T[]
  readonly reset: (
    resetRegistration?: (registration: T) => void,
    onFailure?: (cause: unknown, registration: T) => void,
  ) => void
}

export class DuplicatePluginRegistrationError extends Error {
  readonly key: string

  constructor(key: string) {
    super(
      `A organisation frontend plugin registration already exists for "${key}"`,
    )
    this.name = "DuplicatePluginRegistrationError"
    this.key = key
  }
}

export const createRegistrationRegistry = <T>(
  getKey: (registration: T) => string,
): RegistrationRegistry<T> => {
  const registrations = new Map<string, T>()

  return {
    register(registration) {
      const key = getKey(registration)
      if (registrations.has(key)) {
        throw new DuplicatePluginRegistrationError(key)
      }
      registrations.set(key, registration)
      return () => {
        if (registrations.get(key) === registration) {
          registrations.delete(key)
        }
      }
    },
    get: (key) => registrations.get(key),
    list: () => Array.from(registrations.values()),
    reset(resetRegistration, onFailure) {
      if (resetRegistration) {
        for (const registration of registrations.values()) {
          try {
            resetRegistration(registration)
          } catch (cause) {
            try {
              onFailure?.(cause, registration)
            } catch {
              // Failure observers are outside the plugin lifecycle.
            }
          }
        }
      }
      registrations.clear()
    },
  }
}

export const activateOrganisationFrontendPlugin = async (
  plugin: OrganisationFrontendPlugin,
  host: OrganisationFrontendPluginHost,
): Promise<void> => {
  const disposers: RegistrationDisposer[] = []
  const register =
    <T>(registerCapability: (registration: T) => RegistrationDisposer) =>
    (registration: T): RegistrationDisposer => {
      const dispose = registerCapability(registration)
      disposers.push(dispose)
      return dispose
    }
  const transactionalHost = {
    ...host,
    analytics: { register: register(host.analytics.register) },
    formRenderers: { register: register(host.formRenderers.register) },
    executionMenu: { register: register(host.executionMenu.register) },
  } satisfies OrganisationFrontendPluginHost

  try {
    await plugin.activate(transactionalHost)
  } catch (cause) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Roll back every capability even if a disposer fails.
      }
    }
    throw cause
  }
}

export const activateOrganisationFrontendPlugins = async (
  plugins: readonly OrganisationFrontendPlugin[],
  host: OrganisationFrontendPluginHost,
  onFailure?: (failure: OrganisationFrontendPluginFailure) => void,
): Promise<void> => {
  const pluginIds = new Set<string>()

  for (const plugin of plugins) {
    if (pluginIds.has(plugin.id)) {
      try {
        onFailure?.({
          pluginId: plugin.id,
          cause: new DuplicatePluginRegistrationError(plugin.id),
        })
      } catch {
        // Failure observers must not break activation isolation.
      }
      continue
    }
    pluginIds.add(plugin.id)

    try {
      await activateOrganisationFrontendPlugin(plugin, host)
    } catch (cause) {
      try {
        onFailure?.({ pluginId: plugin.id, cause })
      } catch {
        // Failure observers must not break activation isolation.
      }
    }
  }
}
