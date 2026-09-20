import "server-only"
import { type Session, subjects } from "@pf/auth-session"
import { getFrontendAuthClientConfig } from "./issuer"
import { decodeJwtPayload } from "./jwt"

/** Call only after signature, issuer, audience and expiry verification. No caching. */
export async function acceptVerifiedSession(
  session: Session,
  accessToken: string,
): Promise<Session | null> {
  const claims = decodeJwtPayload(accessToken)
  const properties = claims?.properties
  const tokenHasDelegation =
    typeof properties === "object" &&
    properties !== null &&
    "delegation" in properties
  // A frontend-supplied marker cannot upgrade a human token, and schema
  // projection must not strip a signed marker into a human/service session.
  if (tokenHasDelegation !== "delegation" in session) return null
  if (!("delegation" in session)) {
    return "delegationRoleSelection" in session ? null : session
  }
  if (
    !("email" in session) ||
    !session.delegation ||
    session.humanAuthentication !== undefined
  )
    return null
  try {
    const { issuer, jwt } = getFrontendAuthClientConfig()
    const url = new URL(issuer)
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return null
    const response = await fetch(`${issuer}/oauth/delegation/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accessToken }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || !("session" in body))
      return null
    const parsed = await subjects.providerUser["~standard"].validate(
      body.session,
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
