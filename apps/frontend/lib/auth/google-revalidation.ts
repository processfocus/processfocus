import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Exit, Schema } from "effect"
import { type Session, getFrontendJwt } from "@pf/auth-session"
import { DEFAULT_REFRESH_TOKEN_MAX_AGE } from "./config"

const Identity = Schema.Struct({
  subject: Schema.NonEmptyString,
  deadline: Schema.Number,
})
const Attempt = Schema.Struct({
  subject: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  destination: Schema.NonEmptyString,
  expiresAt: Schema.Number,
})

export const googleRevalidationMaxAge = DEFAULT_REFRESH_TOKEN_MAX_AGE
export const googleRevalidationAttemptMaxAge = 600
const attemptPrefix = "google-revalidation."

export function isDocumentNavigation(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  )
}

// Use the existing confidential Dashboard credential as the signing key. These
// cookies are only identity/flow context and never accepted as credentials.
const mac = (purpose: string, body: string): Buffer => {
  const jwt = getFrontendJwt()
  if (!jwt) throw new Error("Dashboard client credential is unavailable")
  return createHmac("sha256", jwt)
    .update(`pf/dashboard/google-revalidation/${purpose}:`)
    .update(body)
    .digest()
}

function seal(purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${mac(purpose, body).toString("base64url")}`
}

function unseal(purpose: string, value: string | undefined): unknown {
  const [body, signature, extra] = value?.split(".") ?? []
  if (!body || !signature || extra !== undefined) return undefined
  try {
    const actual = Buffer.from(signature, "base64url")
    const expected = mac(purpose, body)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return undefined
    const payload: unknown = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    )
    return payload
  } catch {
    return undefined
  }
}

export function googleSso(session: Session | undefined) {
  return session &&
    "sso" in session &&
    session.sso?.provider === "google" &&
    session.humanSession &&
    !session.delegation &&
    !session.workload
    ? session.sso
    : undefined
}

export function sealGoogleIdentity(sso: {
  subject: string
  expiresAt: number
}): string {
  return seal("identity", { subject: sso.subject, deadline: sso.expiresAt })
}

export function expiredGoogleIdentity(value: string | undefined) {
  const result = Schema.decodeUnknownExit(Identity)(unseal("identity", value))
  if (!Exit.isSuccess(result)) return undefined
  const now = Date.now()
  return now >= result.value.deadline &&
    now < result.value.deadline + googleRevalidationMaxAge * 1000
    ? result.value
    : undefined
}

export function sealGoogleAttempt(
  attempt: Omit<typeof Attempt.Type, "expiresAt">,
): string {
  return (
    attemptPrefix +
    seal("attempt", {
      ...attempt,
      expiresAt: Date.now() + googleRevalidationAttemptMaxAge * 1000,
    })
  )
}

export function readGoogleAttempt(value: string | undefined) {
  if (!value?.startsWith(attemptPrefix)) return undefined
  const result = Schema.decodeUnknownExit(Attempt)(
    unseal("attempt", value.slice(attemptPrefix.length)),
  )
  return Exit.isSuccess(result) && Date.now() < result.value.expiresAt
    ? result.value
    : null
}
