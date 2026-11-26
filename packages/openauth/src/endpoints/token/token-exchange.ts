import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { getIssuerUrl } from "../../request"
import { errorJson } from "../../response"
import { IssuerCallbacks } from "../../services/callbacks"
import type { KeyManagementService } from "../../services/key-management"
import type { StorageService } from "../../storage/storage"
import { generateTokens } from "../_internal/token-generation"

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token"

export const handleTokenExchangeGrant = (form: Map<string, string>): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  IssuerCallbacks | HttpServerRequest.HttpServerRequest | KeyManagementService | StorageService
> =>
  Effect.gen(function* () {
    const callbacks = yield* IssuerCallbacks
    const request = yield* HttpServerRequest.HttpServerRequest
    const assertion = form.get("subject_token")
    const allowed = new Set(["grant_type", "subject_token", "subject_token_type", "requested_token_type", "client_id", "audience", "scope"])
    if (!assertion || assertion.length > 16_384 ||
      !["urn:ietf:params:oauth:token-type:id_token", accessTokenType].includes(form.get("subject_token_type") ?? "") ||
      (form.has("requested_token_type") && form.get("requested_token_type") !== accessTokenType) ||
      [...form.keys()].some((key) => !allowed.has(key)) || request.headers["authorization"]) {
      return yield* errorJson("invalid_request", "Invalid token exchange request", 400)
    }
    if (!callbacks.exchange) return yield* errorJson("unsupported_grant_type", "Token exchange unavailable", 400)
    const admitted = yield* callbacks.exchange({
      assertion,
      assertionType: form.get("subject_token_type") ?? "",
      scope: form.get("scope"),
      clientId: form.get("client_id"),
      audience: form.get("audience"),
      issuer: yield* getIssuerUrl(request.headers),
    })
    const tokens = yield* generateTokens({
      type: admitted.type,
      properties: admitted.properties,
      subject: admitted.subject,
      clientID: admitted.clientId,
      audience: admitted.audience,
      // The admitted absolute deadline below caps this maximum to the binding's lifetime.
      ttl: { access: 5400, refresh: 0 },
      expiresAt: admitted.expiresAt,
      timeUsed: undefined,
      nextToken: undefined,
    }, { generateRefreshToken: false })
    return HttpServerResponse.jsonUnsafe({
      access_token: tokens.access,
      token_type: "Bearer",
      issued_token_type: accessTokenType,
      expires_in: tokens.expiresIn,
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } })
  }).pipe(Effect.catch(() => errorJson("invalid_grant", "Token exchange rejected", 400)))
