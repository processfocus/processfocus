/** External script metadata emitted for a organisation frontend plugin. */
export interface PluginScript {
  readonly id: string
  readonly src: string
  readonly async?: boolean
  readonly defer?: boolean
}

/**
 * Provider-neutral hook used to convert custom schema annotations into
 * serializable frontend plugin data.
 */
export interface WalkerPlugin {
  readonly type: string
  matchAnnotation(annotations: Record<symbol, unknown>): boolean
  extractData?(annotations: Record<symbol, unknown>): unknown
  readonly scripts?: PluginScript[]
  readonly cleanup?: () => void
}

const walkerPlugins = new Map<string, WalkerPlugin>()

export const registerWalkerPlugin = (plugin: WalkerPlugin): void => {
  if (
    process.env["NODE_ENV"] !== "production" &&
    walkerPlugins.has(plugin.type)
  ) {
    console.warn(
      `[plugin-registry] Overwriting existing walker plugin "${plugin.type}"`,
    )
  }
  walkerPlugins.set(plugin.type, plugin)
}

export const unregisterWalkerPlugin = (type: string): void => {
  walkerPlugins.delete(type)
}

export const cleanupAllPlugins = (): void => {
  for (const plugin of walkerPlugins.values()) plugin.cleanup?.()
}

export const getMatchingPlugin = (
  annotations: Record<symbol, unknown>,
): WalkerPlugin | undefined => {
  for (const plugin of walkerPlugins.values()) {
    if (plugin.matchAnnotation(annotations)) return plugin
  }
  return undefined
}
