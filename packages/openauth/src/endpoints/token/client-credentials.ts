/**
 * Client credentials grant handler for token endpoint.
 * @packageDocumentation
 */
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { errorJson } from "../../response"
import type { ClientRegistryService } from "../../services/client-registry"
import type { KeyManagementService } from "../../services/key-management"
import { ProviderRegistryService } from "../../services/provider-registry"
import {
  authenticateClient,
  buildInvalidClientResponse,
} from "../_internal/client-authentication"

/**
 * Result of client credentials grant.
 * Can be an HttpServerResponse (error) or instruction for further processing.
 */
export type ClientCredentialsResult =
  | HttpServerResponse.HttpServerResponse
  | {
      readonly needsUpstreamProvider: true
      readonly provider: string
      readonly clientId: string
      readonly clientAudience: string
    }
  | {
      readonly needsSuccessCallback: true
      readonly scope: string | undefined
      readonly clientId: string
      readonly clientAudience: string
    }

/**
 * Handle grant_type=client_credentials
 * Issues tokens for M2M (machine-to-machine) authentication.
 *
 * Supports two modes:
 * 1. Direct M2M (no provider): Issues tokens directly via success callback
 * 2. Upstream provider: Delegates to an OAuth provider that supports client credentials
 */
export const handleClientCredentialsGrant = (
  form: Map<string, string>,
): Effect.Effect<
  ClientCredentialsResult,
  never,
  | ClientRegistryService
  | ProviderRegistryService
  | KeyManagementService
  | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistryService

    // Authenticate client
    const authResult = yield* authenticateClient(form).pipe(
      Effect.catchTag("@pf/openauth/ClientAuthError", (error) =>
        Effect.succeed({ error } as const),
      ),
    )

    if ("error" in authResult) {
      return yield* buildInvalidClientResponse(authResult.error.description)
    }

    const { client } = authResult

    if (client.isPublic) {
      return yield* errorJson(
        "unauthorized_client",
        "Public clients cannot use client_credentials",
        400,
      )
    }

    const provider = form.get("provider")

    // Direct client credentials flow (M2M without upstream provider)
    if (!provider) {
      const scope = form.get("scope")
      // Signal to caller that success callback should be invoked
      return {
        needsSuccessCallback: true as const,
        scope: scope ?? undefined,
        clientId: client.id,
        clientAudience: client.audience,
      }
    }

    // Upstream provider client credentials flow
    if (!providerRegistry.hasProvider(provider)) {
      return yield* errorJson("invalid_request", "Invalid provider parameter", 400)
    }

    // Signal to caller that upstream provider should be used
    return {
      needsUpstreamProvider: true as const,
      provider,
      clientId: client.id,
      clientAudience: client.audience,
    }
  })
