import "server-only"

import { Data, DateTime, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { cacheLife, cacheTag } from "next/cache"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
} from "@pf/auth-local-cedar"
import {
  Application,
  AuthorizationService,
  DelegationPrincipal,
  type FeatureAction,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { type ProviderUserSession, getFrontendJwt } from "@pf/auth-session"
import { RequestTime } from "@pf/request-time"
import {
  type FeaturePermissions,
  noFeaturePermissions,
} from "@/lib/feature-permissions"
import { fetchCedarPolicies } from "@/lib/graphql/queries"
import {
  createServerGraphqlClient,
  retryGraphqlRead,
} from "@/lib/graphql/server-client"

export class CedarConfigError extends Data.TaggedError("@pf/CedarConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const FRONTEND_JWT_TOKEN = getFrontendJwt()

/**
 * Fetch Cedar policies. Hosted policy artifacts refresh with a new deployment;
 * the local runtime's policy watcher invalidates this tag via /api/revalidate.
 */
async function getCedarPolicies(): Promise<{
  policiesText: readonly string[]
  schemaText: string
}> {
  "use cache"
  cacheLife("max")
  cacheTag("cedar-policies")

  if (!FRONTEND_JWT_TOKEN) {
    throw new CedarConfigError({
      message:
        "FRONTEND_JWT_TOKEN is not configured - authorization is disabled",
    })
  }

  console.log("[Cedar] Fetching policies from GraphQL cedarPolicies query")

  const client = createServerGraphqlClient(FRONTEND_JWT_TOKEN)
  const data = await retryGraphqlRead(() => fetchCedarPolicies(client))
  if (!data) {
    throw new Error("GraphQL cedarPolicies query returned no data")
  }
  console.log(`[Cedar] Policies cached: ${data.policies.length} file(s)`)
  return {
    policiesText: data.policies,
    schemaText: data.schema,
  }
}

/**
 * Fetches Cedar policies via the Next.js cache.
 */
const fetchCedarPoliciesWithCache = Effect.gen(function* () {
  return yield* Effect.tryPromise({
    try: () => getCedarPolicies(),
    catch: (error) =>
      new CedarConfigError({
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch Cedar policies",
        cause: error,
      }),
  })
})

/**
 * Creates a Cedar config layer that fetches policies from the GraphQL server.
 */
const CedarConfigLayer = Layer.effect(
  LocalCedarConfig,
  fetchCedarPoliciesWithCache,
).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * RequestTime layer with current timestamp.
 */
const RequestTimeLayer = Layer.effect(RequestTime, DateTime.now)

/**
 * Complete Cedar authorization layer for SSR pages.
 * Combines Cedar policies, schema, and request time.
 * Provides both AuthorizationService and RequestTime to consumers.
 */
export const CedarAuthorizationLayer = Layer.merge(
  Layer.provide(
    LocalCedarAuthorizationLive,
    Layer.merge(CedarConfigLayer, RequestTimeLayer),
  ),
  RequestTimeLayer,
)

/** Default application ID for feature-based authorization checks */
const DEFAULT_APPLICATION_ID = "default"

/**
 * Check all feature permissions for a provider user session.
 * Returns an object with boolean flags for each feature.
 *
 * If authorization fails (Cedar error), all permissions are denied.
 */
export const checkFeaturePermissions = (
  session: ProviderUserSession,
): Effect.Effect<
  FeaturePermissions,
  never,
  AuthorizationService | RequestTime
> =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService

    const principal = session.delegation
      ? new DelegationPrincipal(session.delegation.id, {
          owner: session.email,
          name: session.delegation.name,
          roles: session.roles,
          orgUnitId: session.orgUnitPath,
        })
      : new ProviderUserPrincipal(session.email, {
          roles: session.roles,
          orgUnitId: session.orgUnitPath,
        })
    const app = new Application(DEFAULT_APPLICATION_ID)

    const checkFeature = (action: FeatureAction) =>
      auth.canAccessFeature(principal, app, action).pipe(
        Effect.catch((error) => {
          console.error(
            `[Cedar] Authorization check failed for action "${action}":`,
            error,
          )
          return Effect.succeed(false)
        }),
      )

    const [
      administerUsers,
      administerOAuthProviders,
      showProcessState,
      viewAuthorization,
    ] = yield* Effect.all([
      checkFeature("administerUsers"),
      checkFeature("administerOAuthProviders"),
      checkFeature("showProcessState"),
      checkFeature("viewAuthorization"),
    ])

    return {
      administerUsers,
      administerOAuthProviders,
      showProcessState,
      viewAuthorization,
    }
  })

/**
 * Check if provider user has any settings-related permissions.
 * Used to determine if the Settings link should be shown in the sidebar.
 */
export const hasAnySettingsPermission = (
  permissions: FeaturePermissions,
): boolean =>
  permissions.administerUsers || permissions.administerOAuthProviders

/**
 * Get feature permissions for a provider user session.
 * This is a convenience function that runs the Effect with the Cedar layer.
 *
 * Returns default (all false) permissions if Cedar check fails.
 */
export const getFeaturePermissions = async (
  session: ProviderUserSession,
): Promise<FeaturePermissions> => {
  const effect = checkFeaturePermissions(session).pipe(
    Effect.provide(CedarAuthorizationLayer),
    Effect.catch(() => Effect.succeed(noFeaturePermissions)),
  )

  return Effect.runPromise(effect)
}

/**
 * Ensure Cedar policies are fetched and cached.
 * Awaitable — safe to call during SSR/prerendering.
 */
export const ensureCedarPolicies = (): Promise<void> =>
  getCedarPolicies().then(() => undefined)
