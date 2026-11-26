import { Clock, Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SignJWT, jwtVerify } from "jose"
import {
  PROJECT_SUBSCRIPTION_AUDIENCE,
  PROJECT_SUBSCRIPTION_PURPOSE,
  ProviderUserSessionSchema,
  getAudience,
  getRealtimeRecipientId,
} from "@pf/auth-session"
import { type Issuer, KeyManagementService, getIssuerUrl } from "@pf/openauth"

/** Exchange a verified human credential for subscription authority only. */
export const makeProjectSubscriptionHandler = Effect.gen(function* () {
  const keys = yield* KeyManagementService
  const handler: Issuer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const json = (body: unknown, status = 200) =>
      HttpServerResponse.jsonUnsafe(body, {
        status,
        headers: { "cache-control": "no-store" },
      })
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    const token = request.headers["authorization"]?.replace(/^Bearer /, "")
    if (!token) return json({ error: "invalid_token" }, 401)
    const issuer = yield* getIssuerUrl(request.headers)
    const signingKeys = yield* keys.allSigningKeys
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(
        token,
        async (header) => {
          const key = signingKeys.find(
            (key) => key.id === header.kid && key.alg === header.alg,
          )
          if (!key) throw new Error("Unknown signing key")
          return key.public
        },
        { issuer, audience: getAudience(), requiredClaims: ["exp", "sub"] },
      ),
    )
    const payload = verified.payload
    if (
      payload["mode"] !== "access" ||
      payload["type"] !== "providerUser" ||
      !payload.exp
    )
      return json({ error: "invalid_token" }, 401)
    const properties = yield* Schema.decodeUnknownEffect(
      ProviderUserSessionSchema,
    )(payload["properties"])
    if (properties.delegation || properties.humanSession !== true)
      return json({ error: "invalid_token" }, 403)
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const exp = Math.min(payload.exp, now + 300)
    const recipientId = yield* Effect.promise(() =>
      getRealtimeRecipientId(properties, exp),
    )
    if (!recipientId || exp <= now) return json({ error: "invalid_token" }, 401)
    const key = yield* keys.signingKey
    const ticket = yield* Effect.tryPromise(() =>
      new SignJWT({
        type: "projectSubscription",
        purpose: PROJECT_SUBSCRIPTION_PURPOSE,
        properties,
        recipientId,
      })
        .setProtectedHeader({ alg: key.alg, kid: key.id })
        .setIssuer(issuer)
        .setAudience(PROJECT_SUBSCRIPTION_AUDIENCE)
        .setSubject(payload.sub ?? properties.userId)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(key.private),
    )
    return json({ ticket, recipientId, expiresAt: exp })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "invalid_token" },
          { status: 401, headers: { "cache-control": "no-store" } },
        ),
      ),
    ),
  )
  return handler
})
