/**
 * UserInfo endpoint handler.
 * GET /oauth/userinfo
 * @packageDocumentation
 */
import { HttpServerRequest, type HttpServerResponse } from "@effect/platform"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Either } from "effect"
import { jwtVerify } from "jose"
import { getIssuerUrl } from "../request"
import { errorJson, json } from "../response"
import { ClientRegistryService } from "../services/client-registry"
import { SubjectsConfig } from "../services/config"
import {
  KeyManagementService,
  type NoSigningKeysError,
} from "../services/key-management"
import type { StorageError } from "../storage/storage"
import type { SubjectSchema } from "../subject"
import { JwtVerificationError, type MissingHostError, type OAuthEndpointError } from "./errors"

/**
 * UserInfo response - validated subject properties.
 */
export type UserinfoResponse = unknown

/**
 * Handle GET /oauth/userinfo
 * Returns the subject properties from a valid access token.
 */
export const handleUserinfo: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  MissingHostError | OAuthEndpointError | StorageError | NoSigningKeysError,
  | KeyManagementService
  | ClientRegistryService
  | SubjectsConfig
  | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const keyMgmt = yield* KeyManagementService
  const clientRegistry = yield* ClientRegistryService
  const subjects = yield* SubjectsConfig
  const request = yield* HttpServerRequest.HttpServerRequest
  const header = request.headers["authorization"]

  if (!header) {
    return yield* errorJson(
      "invalid_request",
      "Missing Authorization header",
      400,
    )
  }

  const [type, token] = header.split(" ")

  if (type !== "Bearer") {
    return yield* errorJson(
      "invalid_request",
      "Missing or invalid Authorization header",
      400,
    )
  }

  if (!token) {
    return yield* errorJson("invalid_request", "Missing token", 400)
  }

  const validAudiences = [...clientRegistry.configuredClientIds]
  const signingKeyPair = yield* keyMgmt.signingKey

  const issuerUrl = yield* getIssuerUrl(request.headers)

  const verifyResult = yield* Effect.tryPromise({
    try: () =>
      jwtVerify<{
        mode: "access"
        type: keyof SubjectSchema
        properties: StandardSchemaV1.InferInput<
          SubjectSchema[keyof SubjectSchema]
        >
      }>(token, () => Promise.resolve(signingKeyPair.public), {
        issuer: issuerUrl,
        audience: validAudiences,
      }),
    catch: (cause) =>
      new JwtVerificationError({
        message: "Access token verification failed",
        cause,
      }),
  }).pipe(Effect.either)

  if (Either.isLeft(verifyResult)) {
    return yield* errorJson("invalid_token", "Invalid token", 401)
  }

  const result = verifyResult.right
  const subjectSchema = subjects[result.payload.type]
  if (!subjectSchema) {
    return yield* errorJson("invalid_token", "Invalid token", 401)
  }

  const validateResult = subjectSchema["~standard"].validate(
    result.payload.properties,
  )
  const validated = yield* Effect.promise(async () =>
    validateResult instanceof Promise ? validateResult : validateResult,
  )

  if (!validated.issues && result.payload.mode === "access") {
    return yield* json(validated.value)
  }

  return yield* errorJson("invalid_token", "Invalid token", 401)
})
