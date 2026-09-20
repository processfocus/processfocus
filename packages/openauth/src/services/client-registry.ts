/**
 * Client registry service for OAuth client management.
 * Handles both static and dynamic client resolution.
 * @packageDocumentation
 */
import { Context, Data, Effect, Layer } from "effect"
import type { NormalizedClient } from "../endpoints/types"
import type { IssuerClient } from "../issuer"

/**
 * Error thrown when client registry configuration is invalid.
 */
export class ClientRegistryError extends Data.TaggedError(
  "@pf/ClientRegistryError",
)<{
  readonly message: string
  readonly clientId?: string
}> {}

/**
 * Service interface for client registry operations.
 */
export interface ClientRegistryServiceInterface {
  /**
   * Get a client by ID. Checks static registry first, then dynamic resolver.
   * @param id - The client ID to look up
   * @returns The normalized client or undefined if not found
   */
  readonly getClient: (
    id: string,
  ) => Effect.Effect<NormalizedClient | undefined>
  /**
   * The static client registry (immutable map of configured clients).
   */
  readonly staticClients: ReadonlyMap<string, NormalizedClient>
  /**
   * List of configured client IDs (for validation).
   */
  readonly configuredClientIds: readonly string[]
}

/**
 * Effect service tag for client registry.
 */
export class ClientRegistryService extends Context.Tag(
  "@pf/openauth/ClientRegistryService",
)<ClientRegistryService, ClientRegistryServiceInterface>() {}

/**
 * Normalize an origin URL.
 */
function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Origin must use http or https: ${origin}`)
  }
  return parsed.origin
}

/**
 * Normalize a redirect URI.
 */
function normalizeRedirectUri(uri: string): string {
  const parsed = new URL(uri)
  // Remove trailing slash from path
  if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }
  return parsed.toString()
}

/**
 * Build a client registry from issuer clients.
 * Returns an Effect that fails with ClientRegistryError on validation errors.
 */
export function buildClientRegistry(
  entries: IssuerClient[],
): Effect.Effect<Map<string, NormalizedClient>, ClientRegistryError> {
  return Effect.gen(function* () {
    const registry = new Map<string, NormalizedClient>()
    for (const entry of entries) {
      if (!entry.id) {
        return yield* new ClientRegistryError({
          message: "Client entry is missing an id",
        })
      }
      if (registry.has(entry.id)) {
        return yield* new ClientRegistryError({
          message: `Duplicate client id configured: ${entry.id}`,
          clientId: entry.id,
        })
      }
      if (entry.secretHash !== undefined && entry.secretHash.trim() === "") {
        return yield* new ClientRegistryError({
          message: `Client ${entry.id} has empty secretHash - use a valid hash or omit for public clients`,
          clientId: entry.id,
        })
      }
      const configuredMethod = entry.tokenEndpointAuthMethod
      // client_jwt clients are confidential: the JWT (signed by the server's
      // own keys) acts as the credential, so no secretHash is needed.
      const isConfidential =
        !!entry.secretHash || configuredMethod === "client_jwt"
      if (
        !isConfidential &&
        (!entry.redirectUris || entry.redirectUris.length === 0)
      ) {
        return yield* new ClientRegistryError({
          message: `Client ${entry.id} must declare at least one redirect URI`,
          clientId: entry.id,
        })
      }
      const redirectUris = (entry.redirectUris ?? []).map(normalizeRedirectUri)
      const corsOrigins = (entry.corsOrigins ?? []).map(normalizeOrigin)
      if (configuredMethod === "none" && isConfidential) {
        return yield* new ClientRegistryError({
          message: `Client ${entry.id} cannot set a secretHash while using public authentication`,
          clientId: entry.id,
        })
      }
      if (
        configuredMethod &&
        configuredMethod !== "none" &&
        configuredMethod !== "client_jwt" &&
        !entry.secretHash
      ) {
        return yield* new ClientRegistryError({
          message: `Client ${entry.id} must configure a secretHash for ${configuredMethod}`,
          clientId: entry.id,
        })
      }

      const normalized: NormalizedClient = {
        id: entry.id,
        redirectUris,
        corsOrigins,
        secretHash: entry.secretHash,
        enforcedAuthMethod:
          configuredMethod ?? (isConfidential ? undefined : "none"),
        isPublic: !isConfidential,
        audience: entry.audience ?? entry.id,
      }

      registry.set(entry.id, normalized)
    }
    return registry
  })
}

/**
 * Create a ClientRegistryService layer from client configuration.
 *
 * @param clients - Static client configurations
 * @param resolveClient - Optional dynamic client resolver callback
 */
export const makeClientRegistryService = (
  clients: IssuerClient[],
  resolveClient?: (
    clientId: string,
  ) => Effect.Effect<IssuerClient | undefined>,
): Layer.Layer<ClientRegistryService, ClientRegistryError, never> =>
  Layer.effect(
    ClientRegistryService,
    Effect.gen(function* () {
      const staticClients = yield* buildClientRegistry(clients)
      const configuredClientIds = clients.map((c) => c.id)

      return {
        staticClients,
        configuredClientIds,
        getClient: (clientId: string) =>
          Effect.gen(function* () {
            const staticClient = staticClients.get(clientId)
            if (staticClient) return staticClient

            if (!resolveClient) return undefined

            const dynamic = yield* resolveClient(clientId)
            if (!dynamic) return undefined

            // Dynamic clients must be confidential
            if (!dynamic.secretHash) {
              yield* Effect.logWarning(
                `Dynamic client ${clientId} rejected: no secretHash`,
              )
              return undefined
            }

            return {
              id: dynamic.id,
              redirectUris: (dynamic.redirectUris ?? []).map(
                normalizeRedirectUri,
              ),
              corsOrigins: (dynamic.corsOrigins ?? []).map(normalizeOrigin),
              secretHash: dynamic.secretHash,
              enforcedAuthMethod: dynamic.tokenEndpointAuthMethod,
              isPublic: false,
              audience: dynamic.audience ?? dynamic.id,
            }
          }),
      }
    }),
  )
