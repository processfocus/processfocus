/**
 * Compatibility surface for the shared public runtime registry. Keeping the
 * state in one published module prevents private runtimes and internal form
 * walkers from registering against different singleton instances.
 */
export {
  type PluginScript,
  type WalkerPlugin,
  cleanupAllPlugins,
  getMatchingPlugin,
  registerWalkerPlugin,
  unregisterWalkerPlugin,
} from "@processfocus/runtime"
