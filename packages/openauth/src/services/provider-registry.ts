/**
 * Provider registry service for OAuth provider management.
 * Handles both static and dynamic provider resolution.
 * @packageDocumentation
 */
import { Context, Effect, Layer } from "effect"
import type { Provider } from "../provider/provider"

/**
 * Service interface for provider registry operations.
 */
export interface ProviderRegistryServiceInterface {
  /**
   * The static provider registry (providers configured at startup).
   */
  readonly staticProviders: ReadonlyMap<string, Provider<unknown>>
  /**
   * List all available provider names (static + dynamic).
   */
  readonly listProviders: Effect.Effect<readonly string[]>
  /**
   * Whether Passkey Open Registration is available (inviteOnly disabled).
   * Defaults to false when the application does not supply a resolver.
   */
  readonly isPasskeyOpenRegistration: Effect.Effect<boolean>
  /**
   * Check if a static provider exists by name.
   * @param name - Provider name
   */
  readonly hasProvider: (name: string) => boolean
  /**
   * Resolve a provider by name (static first, then dynamic).
   * @param name - Provider name to resolve
   * @returns The provider or undefined if not found
   */
  readonly resolveProvider: (
    name: string,
  ) => Effect.Effect<Provider<unknown> | undefined>
}

/**
 * Effect service tag for provider registry.
 */
export class ProviderRegistryService extends Context.Tag(
  "@pf/openauth/ProviderRegistryService",
)<ProviderRegistryService, ProviderRegistryServiceInterface>() {}

/**
 * Create a ProviderRegistryService layer from provider configuration.
 *
 * @param providers - Static providers configured at startup
 * @param listProviders - Optional callback to list dynamic providers
 * @param resolveProvider - Optional callback to resolve dynamic providers
 * @param isPasskeyOpenRegistration - Optional Open Registration availability
 */
export const makeProviderRegistryService = (
  providers: Record<string, Provider<unknown>>,
  listProviders?: () => Effect.Effect<readonly string[]>,
  resolveProvider?: (name: string) => Effect.Effect<Provider<unknown> | undefined>,
  isPasskeyOpenRegistration?: () => Effect.Effect<boolean>,
): Layer.Layer<ProviderRegistryService, never, never> =>
  Layer.succeed(
    ProviderRegistryService,
    (() => {
      const staticProviders = new Map(Object.entries(providers))

      return {
        staticProviders,

        listProviders: Effect.gen(function* () {
          const staticNames = [...staticProviders.keys()]
          if (!listProviders) return staticNames

          const dynamicNames = yield* listProviders()
          // Deduplicate - static providers may also be in database
          return [...new Set([...staticNames, ...dynamicNames])]
        }),

        isPasskeyOpenRegistration: Effect.gen(function* () {
          if (!isPasskeyOpenRegistration) return false
          return yield* isPasskeyOpenRegistration()
        }),

        hasProvider: (name: string) => staticProviders.has(name),

        resolveProvider: (name: string) =>
          Effect.gen(function* () {
            // Check static providers first
            const staticProvider = staticProviders.get(name)
            if (staticProvider) return staticProvider

            // Try dynamic resolution if available
            if (!resolveProvider) return undefined
            return yield* resolveProvider(name)
          }),
      }
    })(),
  )
