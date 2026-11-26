import "server-only"
import { type Session, subjects } from "@pf/auth-session"
import { decodeJwtPayload } from "./jwt"
import { getGraphqlEndpoint } from "@/lib/graphql/endpoint"

/** Call only after signature, issuer, audience and expiry verification. No caching. */
export async function acceptVerifiedSession(
  session: Session,
  accessToken: string,
): Promise<Session | null> {
  const claims = decodeJwtPayload(accessToken)
  const properties = claims?.properties
  const tokenHasWorkload =
    typeof properties === "object" &&
    properties !== null &&
    "workload" in properties
  if (tokenHasWorkload !== "workload" in session) return null
  if (tokenHasWorkload) {
    if (
      !session.workload ||
      !claims?.exp ||
      Date.now() >= Math.min(claims.exp * 1000, session.workload.expiresAt) ||
      claims.exp * 1000 > session.workload.expiresAt ||
      ("email" in session &&
        (session.humanSession ||
          session.humanAuthentication ||
          session.delegation))
    )
      return null
    return "email" in session
      ? acceptCurrentProviderUser(session, accessToken)
      : session
  }
  const tokenHasDelegation =
    typeof properties === "object" &&
    properties !== null &&
    "delegation" in properties
  // A frontend-supplied marker cannot upgrade a human token, and schema
  // projection must not strip a signed marker into a human/service session.
  if (tokenHasDelegation !== "delegation" in session) return null
  if (!("delegation" in session)) {
    if ("delegationRoleSelection" in session) return null
    return "email" in session
      ? acceptCurrentProviderUser(session, accessToken)
      : session
  }
  if (
    !("email" in session) ||
    !session.delegation ||
    session.humanAuthentication !== undefined
  )
    return null
  try {
    const endpoint = getGraphqlEndpoint()
    const url = new URL(endpoint)
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return null
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "query DelegatedSessionAuthority { delegatedSession }",
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (
      typeof body !== "object" ||
      body === null ||
      "errors" in body ||
      !("data" in body) ||
      typeof body.data !== "object" ||
      body.data === null ||
      !("delegatedSession" in body.data)
    )
      return null
    const parsed = await subjects.providerUser["~standard"].validate(
      body.data.delegatedSession,
    )
    if (parsed.issues) return null
    const current = parsed.value
    const expiry = claims?.exp
    if (
      !current.delegation ||
      current.humanAuthentication !== undefined ||
      current.userId !== session.userId ||
      current.email !== session.email ||
      current.delegation.id !== session.delegation.id ||
      current.delegation.generationId !== session.delegation.generationId ||
      current.delegation.expiresAt !== session.delegation.expiresAt ||
      Date.now() >= current.delegation.expiresAt ||
      !expiry ||
      expiry * 1000 > current.delegation.expiresAt
    )
      return null
    return current
  } catch {
    // Never propagate credential-bearing transport/schema error objects.
    return null
  }
}

/** The existing protected API boundary owns live human/workload authority. */
async function acceptCurrentProviderUser(
  session: Session,
  accessToken: string,
): Promise<Session | null> {
  try {
    const response = await fetch(getGraphqlEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "query SessionAuthority { __typename }" }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (
      typeof body !== "object" ||
      body === null ||
      "errors" in body ||
      !("data" in body) ||
      !body.data
    )
      return null
    return session
  } catch {
    return null
  }
}
