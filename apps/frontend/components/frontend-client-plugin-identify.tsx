"use client"

import { Fragment } from "react"
import { useActiveFrontendClientPlugins } from "./frontend-client-plugin-provider"

export function FrontendClientPluginIdentify({
  email,
  name,
  userId,
}: {
  readonly email?: string
  readonly name?: string
  readonly userId: string
}) {
  const activePlugins = useActiveFrontendClientPlugins()

  return activePlugins.map((plugin) => {
    if (!plugin.registration.renderIdentify) {
      return null
    }

    return (
      <Fragment key={plugin.type}>
        {plugin.registration.renderIdentify(plugin.config, {
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
          userId,
          username: userId,
        })}
      </Fragment>
    )
  })
}
