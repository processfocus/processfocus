import type {
  HumanIdentityResolution,
  Oauth2Token,
} from "./oauth2.js"
import {
  type VerifiedHumanIdentity,
  normalizeEmail,
} from "./provider.js"

export const fetchProviderJson = async (
  url: string,
  tokenset: Oauth2Token,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  if (typeof tokenset.access !== "string" || tokenset.access.length === 0) {
    throw new Error("Provider did not return an access token")
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenset.access}`,
      ...headers,
    },
  })
  const value: unknown = await response.json()
  if (
    !response.ok ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Invalid provider identity response")
  }
  return value as Record<string, unknown>
}

export const fetchProviderArray = async (
  url: string,
  tokenset: Oauth2Token,
): Promise<readonly unknown[]> => {
  if (typeof tokenset.access !== "string" || tokenset.access.length === 0) {
    throw new Error("Provider did not return an access token")
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenset.access}`,
    },
  })
  const value: unknown = await response.json()
  if (!response.ok || !Array.isArray(value)) {
    throw new Error("Invalid provider identity response")
  }
  return value
}

export const providerApiIdentity = (input: {
  readonly provider: string
  readonly subject: unknown
  readonly email?: unknown
  readonly emailVerified?: unknown
  readonly verificationClaim: string
  readonly name?: unknown
  readonly givenName?: unknown
  readonly familyName?: unknown
  readonly picture?: unknown
  readonly locale?: unknown
}): HumanIdentityResolution => {
  if (
    (typeof input.subject !== "string" && typeof input.subject !== "number") ||
    String(input.subject).length === 0
  ) {
    throw new Error("Provider identity response has no stable subject")
  }

  const subject = String(input.subject)
  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined
  const email = normalizeEmail(input.email)
  const name = stringValue(input.name)
  const givenName = stringValue(input.givenName)
  const familyName = stringValue(input.familyName)
  const picture = stringValue(input.picture)
  const locale = stringValue(input.locale)
  const claims: Record<string, unknown> = {
    sub: subject,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(givenName ? { given_name: givenName } : {}),
    ...(familyName ? { family_name: familyName } : {}),
    ...(picture ? { picture } : {}),
    ...(locale ? { locale } : {}),
  }

  if (input.emailVerified !== true || !email) return { claims }

  const verifiedIdentity: VerifiedHumanIdentity = {
    type: "verified-human-identity",
    provider: input.provider,
    subject,
    email,
    profile: {
      name: name ?? email,
      ...(givenName ? { givenName } : {}),
      ...(familyName ? { familyName } : {}),
      ...(picture ? { picture } : {}),
      ...(locale ? { locale } : {}),
    },
    emailVerification: {
      method: "provider-api",
      claim: input.verificationClaim,
      verified: true,
    },
  }
  return { claims, verifiedIdentity }
}
