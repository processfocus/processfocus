"use client"

import { createContext, useContext, useMemo } from "react"
import {
  type FrontendClientPluginRegistration,
  getFrontendClientPlugin,
} from "@/lib/frontend-client-plugin-registry"
import type { FrontendManifestAnalyticsPlugin } from "@/lib/frontend-manifest"

interface ActiveFrontendClientPlugin {
  readonly config: unknown
  readonly registration: FrontendClientPluginRegistration
  readonly type: string
}

const FrontendClientPluginContext = createContext<
  ReadonlyArray<ActiveFrontendClientPlugin>
>([])

export function FrontendClientPluginProvider({
  children,
  plugins,
}: {
  readonly children: React.ReactNode
  readonly plugins: ReadonlyArray<FrontendManifestAnalyticsPlugin>
}) {
  const activePlugins = useMemo(
    () =>
      plugins.flatMap((plugin) => {
        const registration = getFrontendClientPlugin(plugin.type)

        if (!registration) {
          return []
        }

        return [
          {
            type: plugin.type,
            config: plugin.config,
            registration,
          },
        ]
      }),
    [plugins],
  )

  return (
    <FrontendClientPluginContext.Provider value={activePlugins}>
      {children}
    </FrontendClientPluginContext.Provider>
  )
}

export const useActiveFrontendClientPlugins = () =>
  useContext(FrontendClientPluginContext)
