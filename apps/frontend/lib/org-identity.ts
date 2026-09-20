import "server-only"

import { cacheTag } from "next/cache"
import { getFrontendJwt } from "@pf/auth-session"
import type { OrgIdentityQuery } from "./generated/gql/graphql"
import { fetchOrgIdentity } from "./graphql/queries"
import { createServerGraphqlClient } from "./graphql/server-client"

type OrgIdentity = NonNullable<OrgIdentityQuery["org"]>

/**
 * Fetches the organization identity for the current user.
 * Requires an access token - caller is responsible for obtaining it.
 *
 * Returns null on failure to allow graceful degradation.
 */
export async function getOrgIdentity(
  accessToken: string,
): Promise<OrgIdentity | null> {
  try {
    const client = createServerGraphqlClient(accessToken)
    return (await fetchOrgIdentity(client)) ?? null
  } catch (error) {
    console.warn(
      "Failed to fetch org identity:",
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

const FRONTEND_JWT_TOKEN = getFrontendJwt()

interface PublicOrgIdentity {
  readonly name: string | null
  readonly acronym: string | null
}

/**
 * Fetches public org identity without authentication.
 * Cached via Next.js Data Cache with "login-page" tag for on-demand invalidation.
 *
 * Throws on error so transient failures are not baked into the cache.
 * Callers should catch and degrade gracefully.
 */
export async function getPublicOrgIdentity(): Promise<PublicOrgIdentity | null> {
  "use cache"
  cacheTag("login-page")

  if (!FRONTEND_JWT_TOKEN) {
    throw new Error("[OrgIdentity] FRONTEND_JWT_TOKEN not configured")
  }
  const client = createServerGraphqlClient(FRONTEND_JWT_TOKEN)
  const org = await fetchOrgIdentity(client)
  if (!org) return null
  return { name: org.name ?? null, acronym: org.acronym ?? null }
}
