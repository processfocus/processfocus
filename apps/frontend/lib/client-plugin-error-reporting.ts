import type { FrontendClientPluginRegistration } from "@/lib/frontend-client-plugin-registry"

interface ActiveFrontendClientPlugin {
  readonly config: unknown
  readonly registration: FrontendClientPluginRegistration
}

export const reportClientException = (
  activePlugins: ReadonlyArray<ActiveFrontendClientPlugin>,
  error: Error,
  properties?: Record<string, unknown>,
): void => {
  if (activePlugins.length === 0) {
    return
  }

  for (const plugin of activePlugins) {
    try {
      plugin.registration.captureClientException?.(
        plugin.config,
        error,
        properties,
      )
    } catch {
      // Telemetry plugins must not change the application error path.
    }
  }
}
