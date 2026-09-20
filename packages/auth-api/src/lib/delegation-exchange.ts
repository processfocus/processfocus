import {
  HttpIncomingMessage,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Clock, DateTime, Effect, Option, Schema } from "effect"
import { jwtVerify } from "jose"
import { getClientId, subjects } from "@pf/auth-session"
import {
  type ClientRegistryService,
  type Issuer,
  KeyManagementService,
  type StorageService,
  authenticateClient,
  generateTokens,
  getIssuerUrl,
} from "@pf/openauth"
import { DelegationDatabase } from "./delegation-database.js"
import { DelegationSessionService } from "./delegation-session.js"

const Input = Schema.Struct({
  secret: Schema.String.pipe(Schema.maxLength(48)),
})
const SessionInput = Schema.Struct({
  accessToken: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(16_384),
  ),
})
const json = (body: unknown, status = 200) =>
  HttpServerResponse.unsafeJson(body, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  })

export const makeDelegationExchangeHandler: Effect.Effect<
  Issuer,
  never,
  ClientRegistryService | KeyManagementService | StorageService
> = Effect.gen(function* () {
  const frontendClientId = getClientId()
  const service = yield* Effect.serviceOption(DelegationSessionService)
  const database = yield* Effect.serviceOption(DelegationDatabase)
  const keys = yield* KeyManagementService
  // Bound aggregate work per issuer instance without retaining secrets or client input.
  let windowStart = 0
  let attempts = 0
  const context = yield* Effect.context<
    ClientRegistryService | KeyManagementService | StorageService
  >()
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "https://localhost")
    if (url.pathname === "/oauth/delegation/availability") {
      if (request.method !== "GET")
        return json({ error: "method_not_allowed" }, 405)
      const issuerUrl = new URL(yield* getIssuerUrl(request.headers))
      if (
        url.search ||
        (issuerUrl.protocol !== "https:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(issuerUrl.hostname))
      )
        return json({ error: "invalid_request" }, 400)
      const { client, method } = yield* authenticateClient(new Map())
      if (client.id !== frontendClientId || method !== "client_jwt")
        return json({ error: "invalid_client" }, 401)
      const secretLoginEnabled =
        Option.isSome(database) &&
        (yield* database.value
          .isSecretLoginEnabled()
          .pipe(Effect.orElseSucceed(() => false)))
      return json({ secretLoginEnabled })
    }
    if (Option.isNone(service))
      return json({ error: "delegated_access_unavailable" }, 403)
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    const sessionRequest =
      new URL(request.url, "https://localhost").pathname ===
      "/oauth/delegation/session"
    const issuerUrl = new URL(yield* getIssuerUrl(request.headers))
    if (
      issuerUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(issuerUrl.hostname)
    )
      return json({ error: "invalid_request" }, 400)
    if (
      new URL(request.url, "https://localhost").search ||
      request.headers["content-type"]?.split(";")[0] !== "application/json"
    )
      return json({ error: "invalid_request" }, 400)
    const now = yield* Clock.currentTimeMillis
    if (now >= windowStart + 60_000) {
      windowStart = now
      attempts = 0
    }
    if (!sessionRequest && ++attempts > 30)
      return json({ error: "rate_limited" }, 429)
    const { client, method } = yield* authenticateClient(new Map())
    if (client.id !== frontendClientId || method !== "client_jwt")
      return json({ error: "invalid_client" }, 401)
    if (sessionRequest) {
      const input = yield* request.json.pipe(
        HttpIncomingMessage.withMaxBodySize(Option.some(20_480)),
        Effect.flatMap(
          Schema.decodeUnknown(SessionInput, { onExcessProperty: "error" }),
        ),
      )
      const signingKeys = yield* keys.allSigningKeys
      const currentTime = yield* DateTime.now
      const verified = yield* Effect.tryPromise(() =>
        jwtVerify(
          input.accessToken,
          async (header) => {
            const key = signingKeys.find(
              (key) => key.id === header.kid && key.alg === header.alg,
            )
            if (!key) throw new Error("Unknown signing key")
            return key.public
          },
          {
            issuer: issuerUrl.toString().replace(/\/$/, ""),
            audience: client.audience,
            requiredClaims: ["exp", "sub"],
            currentDate: DateTime.toDateUtc(currentTime),
          },
        ),
      ).pipe(Effect.option)
      if (Option.isNone(verified)) return json({ error: "invalid_token" }, 401)
      const payload = verified.value.payload
      const raw = payload["properties"]
      if (
        payload["mode"] !== "access" ||
        payload["type"] !== "providerUser" ||
        typeof raw !== "object" ||
        raw === null ||
        !("delegation" in raw)
      )
        return json({ error: "invalid_token" }, 401)
      const parsed = yield* Effect.promise(async () =>
        subjects.providerUser["~standard"].validate(raw),
      )
      if (
        parsed.issues ||
        !parsed.value.delegation ||
        payload.exp === undefined ||
        payload.exp * 1000 > parsed.value.delegation.expiresAt
      )
        return json({ error: "invalid_token" }, 401)
      const session = yield* service.value
        .check(parsed.value)
        .pipe(Effect.option)
      if (Option.isNone(session)) return json({ error: "invalid_token" }, 401)
      return json({ session: session.value })
    }
    const input = yield* request.json.pipe(
      HttpIncomingMessage.withMaxBodySize(Option.some(1024)),
      Effect.flatMap(
        Schema.decodeUnknown(Input, { onExcessProperty: "error" }),
      ),
    )
    const session = yield* service.value.exchange(input.secret)
    const tokens = yield* generateTokens({
      type: "providerUser",
      properties: session,
      subject: `delegation:${session.delegation.id}:${session.delegation.generationId}`,
      clientID: client.id,
      audience: client.audience,
      ttl: { access: 600, refresh: 90 * 24 * 3600 },
      expiresAt: session.delegation.expiresAt,
      timeUsed: undefined,
      nextToken: undefined,
    })
    return json({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: tokens.expiresIn,
      refresh_expires_in: tokens.refreshExpiresIn,
    })
  }).pipe(
    Effect.provide(context),
    // Never report SQL errors, request bodies, verifiers or credential-bearing causes.
    Effect.catchAll(() =>
      Effect.succeed(json({ error: "invalid_grant" }, 400)),
    ),
  )
})
