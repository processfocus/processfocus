import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { cookies, headers } from "next/headers"
import { NextResponse } from "next/server"
import { subjects } from "@pf/auth-session"
import { getAuthClient } from "@/lib/auth/client"
import { DEFAULT_REFRESH_TOKEN_MAX_AGE } from "@/lib/auth/config"
import {
  getAccessTokenCookieOptions,
  getCookieNamesFromHost,
  getRefreshTokenCookieOptions,
} from "@/lib/auth/session"
import { acceptVerifiedSession } from "@/lib/auth/ssr-session"

const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
}

const redirectToLogin = (
  request: Request,
  port: number,
  state: string | null,
) => {
  const redirectTarget = new URLSearchParams({ port: String(port) })
  if (state) redirectTarget.set("state", state)

  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set(
    "redirect",
    `/cli-auth?${redirectTarget.toString()}`,
  )
  return NextResponse.redirect(loginUrl.toString(), {
    headers: securityHeaders,
  })
}

/**
 * CLI auth route handler.
 *
 * Uses the user's refresh token to obtain an access token of up to 8 hours
 * (capped at the effective generation deadline for delegated access)
 * (via scope="cli") and redirects it to the CLI's ephemeral localhost
 * callback server. Session cookies are rotated as part of the refresh.
 *
 * Delegated export requires explicit POST confirmation. Fresh visitors log in
 * first; invalid existing sessions finish with an error callback.
 */
async function handoff(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const rejectConfirmation = () =>
    NextResponse.json(
      { error: "Invalid or expired CLI confirmation. Restart CLI login." },
      { status: 403, headers: securityHeaders },
    )
  if (
    request.method === "POST" &&
    (request.headers.get("origin") !== url.origin ||
      (request.headers.has("sec-fetch-site") &&
        request.headers.get("sec-fetch-site") !== "same-origin") ||
      request.headers.get("content-type")?.split(";")[0] !==
        "application/x-www-form-urlencoded")
  )
    return rejectConfirmation()
  const portParam = url.searchParams.get("port")
  const state = url.searchParams.get("state")

  // Validate port is numeric 1-65535
  const port = Number(portParam)
  if (!portParam || !Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { error: "Invalid or missing port parameter" },
      { status: 400, headers: securityHeaders },
    )
  }

  const h = await headers()
  const host = h.get("host") ?? ""
  const cookieNames = getCookieNamesFromHost(host)

  const cookieStore = await cookies()
  let refreshToken = cookieStore.get(cookieNames.refreshToken)?.value
  let accessToken = cookieStore.get(cookieNames.accessToken)?.value
  const callbackUrl = new URL(`http://localhost:${port}/callback`)
  if (state !== null) callbackUrl.searchParams.set("state", state)
  const fail = (error: "failed" | "expired") => {
    callbackUrl.searchParams.set("error", error)
    return NextResponse.redirect(callbackUrl, {
      status: 303,
      headers: securityHeaders,
    })
  }
  const confirmationCookie = `${url.protocol === "https:" ? "__Host-" : ""}cli_confirmation_${cookieNames.accessToken}`
  const confirmationOptions = {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "strict",
    path: "/",
  } satisfies Parameters<typeof cookieStore.set>[2]
  // The refresh credential is a session-private MAC key; neither it nor the
  // access credential is embedded in the confirmation page or cookie.
  const sign = (challenge: string) =>
    createHmac("sha256", refreshToken ?? "")
      .update(JSON.stringify([challenge, accessToken, url.origin, port, state]))
      .digest("hex")
  if (request.method === "POST") {
    // Finish the pending CLI even if the session expired while the user was
    // reading the confirmation. Failure callbacks never carry credentials.
    if (!refreshToken || !accessToken) return fail("expired")
    const form = await request.formData().catch(() => null)
    const confirmation = form?.get("confirmation")
    if (
      typeof confirmation !== "string" ||
      confirmation !== cookieStore.get(confirmationCookie)?.value
    )
      return fail("failed")
    const match = /^(\d+)\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(confirmation)
    if (!match) return fail("failed")
    const [, deadline, nonce, signature] = match
    if (
      !deadline ||
      !nonce ||
      !signature ||
      Number(deadline) > Date.now() + 300_000 ||
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(sign(`${deadline}.${nonce}`), "hex"),
      )
    )
      return fail("failed")
    if (Number(deadline) <= Date.now()) return fail("expired")
    cookieStore.set(confirmationCookie, "", {
      ...confirmationOptions,
      maxAge: 0,
    })
  }

  if (!refreshToken && !accessToken) {
    return redirectToLogin(request, port, state)
  }
  if (!refreshToken) return fail("expired")

  const authClient = getAuthClient()
  // The issuer rechecks live delegated authority before exporting CLI access.
  let verified = accessToken
    ? await authClient
        .verify(subjects, accessToken, undefined)
        .catch(() => null)
    : null
  // Preserve the proxy's ordinary expired-cookie recovery, without requesting
  // CLI scope. Even a recovered delegated session must still confirm export.
  if (!verified || verified.err) {
    const recovered = await authClient.refresh(refreshToken).catch(() => null)
    if (!recovered || recovered.err || !recovered.tokens) return fail("expired")
    if (
      !Number.isFinite(recovered.tokens.expiresIn) ||
      recovered.tokens.expiresIn <= 0
    )
      return fail("expired")
    accessToken = recovered.tokens.access
    verified = await authClient
      .verify(subjects, accessToken, undefined)
      .catch(() => null)
    if (
      !verified ||
      verified.err ||
      !(await acceptVerifiedSession(verified.subject.properties, accessToken))
    )
      return fail("failed")
    refreshToken = recovered.tokens.refresh ?? refreshToken
    cookieStore.set(
      cookieNames.accessToken,
      accessToken,
      getAccessTokenCookieOptions(recovered.tokens.expiresIn),
    )
    cookieStore.set(
      cookieNames.refreshToken,
      refreshToken,
      getRefreshTokenCookieOptions(
        recovered.tokens.refreshExpiresIn ?? DEFAULT_REFRESH_TOKEN_MAX_AGE,
      ),
    )
  }
  if (!verified || verified.err) return fail("failed")
  if (!accessToken) return fail("expired")
  if (!(await acceptVerifiedSession(verified.subject.properties, accessToken)))
    return fail("failed")
  const delegated = "delegation" in verified.subject.properties
  if (delegated && request.method !== "POST") {
    const challenge = `${Date.now() + 300_000}.${randomBytes(32).toString("hex")}`
    const confirmation = `${challenge}.${sign(challenge)}`
    cookieStore.set(confirmationCookie, confirmation, {
      ...confirmationOptions,
      maxAge: 300,
    })
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm CLI access</title></head><body><main><h1>Allow delegated CLI access?</h1><p>This sends a credential for your delegated session to a local program on port ${port}. It can act with your delegated access until its effective expiry or revocation.</p><p>Continue only if you just ran pfcli auth login and trust that program. Otherwise close this tab.</p><form method="post"><input type="hidden" name="confirmation" value="${confirmation}"><button type="submit">Allow CLI access</button></form></main></body></html>`,
      {
        headers: {
          ...securityHeaders,
          "Referrer-Policy": "same-origin",
          // Browsers also apply form-action to the POST's localhost redirect.
          "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; form-action 'self' http://localhost:${port}; base-uri 'none'`,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    )
  }
  const result = await authClient
    .refresh(refreshToken, { scope: "cli" })
    .catch(() => null)

  if (!result || result.err || !result.tokens) {
    if (delegated) {
      return fail("failed")
    }
    return redirectToLogin(request, port, state)
  }

  const { tokens } = result
  if (!Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) {
    return fail("expired")
  }

  // Publish only a usable credential, with the issuer's capped lifetime.
  cookieStore.set(
    cookieNames.accessToken,
    tokens.access,
    getAccessTokenCookieOptions(tokens.expiresIn ?? 60 * 60),
  )
  if (tokens.refresh) {
    cookieStore.set(
      cookieNames.refreshToken,
      tokens.refresh,
      getRefreshTokenCookieOptions(
        tokens.refreshExpiresIn ?? DEFAULT_REFRESH_TOKEN_MAX_AGE,
      ),
    )
  }

  // Redirect the fresh CLI token to the CLI's localhost callback
  callbackUrl.searchParams.set("access_token", tokens.access)
  callbackUrl.searchParams.set("expires_in", String(tokens.expiresIn))
  if (state) callbackUrl.searchParams.set("state", state)

  return NextResponse.redirect(callbackUrl, {
    status: request.method === "POST" ? 303 : 307,
    headers: securityHeaders,
  })
}

export async function GET(request: Request): Promise<Response> {
  return handoff(request)
}

export async function POST(request: Request): Promise<Response> {
  return handoff(request)
}
