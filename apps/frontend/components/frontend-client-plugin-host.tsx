"use client"

import { Fragment } from "react"
import { getFrontendClientPlugin } from "@/lib/frontend-client-plugin-registry"
import type { FrontendManifestAnalyticsPlugin } from "@/lib/frontend-manifest"

interface FrontendClientPluginHostProps {
  readonly plugins: ReadonlyArray<FrontendManifestAnalyticsPlugin>
}

export function FrontendClientPluginHost({
  plugins,
}: FrontendClientPluginHostProps) {
  return plugins.map((plugin) => {
    const registration = getFrontendClientPlugin(plugin.type)

    if (!registration) {
      return null
    }

    return (
      <Fragment key={plugin.type}>
        {registration.render(plugin.config)}
      </Fragment>
    )
  })
}
