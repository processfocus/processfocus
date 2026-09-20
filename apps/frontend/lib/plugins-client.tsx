"use client"

/**
 * Client-side plugin registration.
 *
 * Renderer plugins require React and must be registered in a Client
 * Component. Import this component from the root layout to ensure
 * renderers are available before any form is displayed.
 */
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { FrontendClientPluginHost } from "@/components/frontend-client-plugin-host"
import { FrontendClientPluginProvider } from "@/components/frontend-client-plugin-provider"
import type {
  FrontendManifest,
  FrontendManifestAnalyticsPlugin,
} from "@/lib/frontend-manifest"
import { loadFrontendManifestPlugins } from "@/lib/frontend-plugin-loaders"

type LoadFrontendManifestPlugins = typeof loadFrontendManifestPlugins

interface FrontendPluginsProps {
  readonly children: ReactNode
  readonly loadPlugins?: LoadFrontendManifestPlugins
  readonly manifest: FrontendManifest
}

const emptyActivePlugins: ReadonlyArray<FrontendManifestAnalyticsPlugin> = []

const hasFrontendPluginEntries = (manifest: FrontendManifest): boolean =>
  manifest.plugins.analytics.length > 0 ||
  manifest.plugins.formComponents.length > 0

const hasFormComponentPluginEntries = (manifest: FrontendManifest): boolean =>
  manifest.plugins.formComponents.length > 0

export const FrontendPlugins = ({
  children,
  loadPlugins = loadFrontendManifestPlugins,
  manifest,
}: FrontendPluginsProps) => {
  const [activeClientPlugins, setActiveClientPlugins] =
    useState(emptyActivePlugins)
  const [frontendPluginsLoaded, setFrontendPluginsLoaded] = useState(
    () => !hasFrontendPluginEntries(manifest),
  )

  useEffect(() => {
    let isCurrent = true

    if (!hasFrontendPluginEntries(manifest)) {
      setActiveClientPlugins(emptyActivePlugins)
      setFrontendPluginsLoaded(true)

      return () => {
        isCurrent = false
      }
    }

    setFrontendPluginsLoaded(false)

    loadPlugins(manifest.plugins).then(
      (plugins) => {
        if (isCurrent) {
          setActiveClientPlugins(plugins)
          setFrontendPluginsLoaded(true)
        }
      },
      (error) => {
        console.error(
          "[frontend-plugins] failed to load frontend plugins",
          error,
        )

        if (isCurrent) {
          setActiveClientPlugins(emptyActivePlugins)
          setFrontendPluginsLoaded(true)
        }
      },
    )

    return () => {
      isCurrent = false
    }
  }, [loadPlugins, manifest])

  if (!frontendPluginsLoaded && hasFormComponentPluginEntries(manifest)) {
    return null
  }

  return (
    <FrontendClientPluginProvider plugins={activeClientPlugins}>
      {children}
      {frontendPluginsLoaded ? (
        <FrontendClientPluginHost plugins={activeClientPlugins} />
      ) : null}
    </FrontendClientPluginProvider>
  )
}
