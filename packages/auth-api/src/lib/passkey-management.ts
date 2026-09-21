import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Data, DateTime, Effect, Either, Option, Schema } from "effect"
import { jwtVerify } from "jose"
import { PasskeyProviderConfigSchema } from "@pf/auth-config"
import { subjects } from "@pf/auth-session"
import {
  ClientRegistryService,
  type Issuer,
  KeyManagementService,
  PasskeyRegistrationResponseSchema,
  Storage,
  StorageService,
  createPasskeyRegistrationOptions,
  getIssuerUrl,
  verifyPasskeyRegistrationAttestation,
} from "@pf/openauth"
import {
  AuthenticationDatabase,
  type PasskeyManagementCredential,
} from "./authentication-database.js"
import {
  type PasskeyCredentialAlreadyOwnedError,
  type PasskeyIdentityNotFoundError,
  type PasskeyManagementDeniedError,
  registerAdditionalPasskeyForAccount,
} from "./passkey-auth.js"
import { getPasskeyUserHandle } from "./passkey-user-handle.js"

class PasskeyManagementRequestError extends Data.TaggedError(
  "PasskeyManagementRequestError",
)<{
  readonly status: number
  readonly error: string
}> {}

const PasskeyName = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(128))
const PasskeyId = Schema.String.pipe(Schema.minLength(1))
const RenamePasskey = Schema.Struct({
  id: PasskeyId,
  name: PasskeyName,
})
const RemovePasskey = Schema.Struct({
  id: PasskeyId,
})
const StartPasskeyEnrollment = Schema.Struct({
  name: PasskeyName,
})
const VerifyPasskeyEnrollment = Schema.Struct({
  challengeId: Schema.String.pipe(Schema.minLength(1)),
  response: PasskeyRegistrationResponseSchema,
})
const ManagementChallenge = Schema.Struct({
  type: Schema.Literal("management"),
  challenge: Schema.String,
  userId: Schema.String,
  userHandle: Schema.String,
  name: PasskeyName,
})

const CHALLENGE_TTL_SECONDS = 300

const json = (body: unknown, status = 200) =>
  HttpServerResponse.unsafeJson(body, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  })

const isTrustedHuman = (session: {
  readonly humanSession?: true | undefined
  readonly humanAuthentication?:
    | {
        readonly providerUserId: string
        readonly method: "passkey"
      }
    | undefined
  readonly delegation?: unknown
  readonly userId: string
}): boolean =>
  session.delegation === undefined &&
  (session.humanSession === true ||
    (session.humanAuthentication?.method === "passkey" &&
      session.humanAuthentication.providerUserId === session.userId))

const listed = (
  organisationName: string,
  account: { readonly userId: string; readonly email: string },
  credentials: readonly PasskeyManagementCredential[],
) => ({
  organisation: { name: organisationName },
  account,
  credentials: credentials.map((credential) => ({
    id: credential.id,
    name: credential.name,
    createdAt: DateTime.formatIso(credential.createdAt),
    lastUsedAt:
      credential.lastUsedAt === null
        ? null
        : DateTime.formatIso(credential.lastUsedAt),
  })),
})

const challengeKey = (challengeId: string) => [
  "passkey",
  "management",
  challengeId,
]

const invalidRequest = () =>
  new PasskeyManagementRequestError({
    status: 400,
    error: "invalid_request",
  })

/** Captures runtime services, not credentials. Every request verifies its bearer anew. */
export const makePasskeyManagementHandler: Effect.Effect<
  Issuer,
  never,
  | AuthenticationDatabase
  | KeyManagementService
  | ClientRegistryService
  | StorageService
  | SqlClient.SqlClient
> = Effect.gen(function* () {
  const authDb = yield* AuthenticationDatabase
  const keys = yield* KeyManagementService
  const clients = yield* ClientRegistryService
  const sql = yield* SqlClient.SqlClient
  const storage = yield* StorageService
  const withAuthDb = <A, E>(
    effect: Effect.Effect<A, E, AuthenticationDatabase>,
  ) => effect.pipe(Effect.provideService(AuthenticationDatabase, authDb))
  const withStorage = <A, E>(effect: Effect.Effect<A, E, StorageService>) =>
    effect.pipe(Effect.provideService(StorageService, storage))

  const handler: Issuer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (
      request.method !== "GET" &&
      request.method !== "PATCH" &&
      request.method !== "POST" &&
      request.method !== "DELETE"
    ) {
      return json({ error: "method_not_allowed" }, 405)
    }
    const token =
      request.headers["authorization"]?.match(/^Bearer ([^ ]+)$/)?.[1]
    if (!token) return json({ error: "invalid_token" }, 401)
    const signingKeys = yield* keys.allSigningKeys
    const issuer = yield* getIssuerUrl(request.headers).pipe(
      Effect.mapError(
        () =>
          new PasskeyManagementRequestError({
            status: 401,
            error: "invalid_token",
          }),
      ),
    )
    const now = yield* DateTime.now
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(
          token,
          async (header) => {
            const key = signingKeys.find(
              (key) => key.id === header.kid && key.alg === header.alg,
            )
            if (!key) throw new Error("Unknown signing key")
            return key.public
          },
          {
            issuer,
            audience: [...clients.staticClients.values()].map(
              (client) => client.audience,
            ),
            requiredClaims: ["exp", "sub"],
            currentDate: DateTime.toDateUtc(now),
          },
        ),
      catch: () =>
        new PasskeyManagementRequestError({
          status: 401,
          error: "invalid_token",
        }),
    })
    if (
      typeof verified.payload.exp !== "number" ||
      verified.payload["mode"] !== "access" ||
      verified.payload["type"] !== "providerUser"
    ) {
      return json({ error: "invalid_token" }, 401)
    }
    const validated = yield* Effect.promise(async () =>
      subjects.providerUser["~standard"].validate(
        verified.payload["properties"],
      ),
    )
    if (validated.issues) return json({ error: "invalid_token" }, 401)
    const session = validated.value
    if (!isTrustedHuman(session)) {
      return json({ error: "management_denied" }, 403)
    }

    const targets = new URL(
      request.url,
      "https://auth.invalid",
    ).searchParams.getAll("ownerUserId")
    if (targets.length > 0) return json({ error: "invalid_request" }, 400)

    const passkeyProvider = yield* authDb.findOAuthProviderByName("passkey")
    if (Option.isNone(passkeyProvider)) {
      return json({ error: "management_denied" }, 403)
    }

    const account = yield* authDb.findProviderUserByUserId(session.userId)
    if (Option.isNone(account)) return json({ error: "invalid_token" }, 401)

    const credentials = yield* authDb.listPasskeyCredentialsForUser(
      session.userId,
    )
    if (credentials.length === 0) {
      return json({ error: "management_denied" }, 403)
    }

    const organisation = yield* authDb.findRootOrgUnit()
    const organisationName = Option.match(organisation, {
      onNone: () => "Organisation",
      onSome: (org) => org.name,
    })
    const payload = listed(
      organisationName,
      { userId: account.value.id, email: account.value.email },
      credentials,
    )

    if (request.method === "GET") return json(payload)

    if (request.method === "DELETE") {
      const body = yield* request.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknown(RemovePasskey, { onExcessProperty: "error" }),
        ),
        Effect.mapError(() => invalidRequest()),
      )
      const removed = yield* authDb.removePasskeyCredential({
        userId: session.userId,
        id: body.id,
      })
      if (removed === "last_credential") {
        return json({ error: "last_credential" }, 409)
      }
      if (removed === "not_found") {
        return json({ error: "management_denied" }, 403)
      }
      const updated = yield* authDb.listPasskeyCredentialsForUser(
        session.userId,
      )
      return json(
        listed(
          organisationName,
          { userId: account.value.id, email: account.value.email },
          updated,
        ),
      )
    }

    if (request.method === "PATCH") {
      const body = yield* request.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknown(RenamePasskey, { onExcessProperty: "error" }),
        ),
        Effect.mapError(() => invalidRequest()),
      )
      const renamed = yield* authDb.renamePasskeyCredential({
        userId: session.userId,
        id: body.id,
        name: body.name,
      })
      if (!renamed) return json({ error: "management_denied" }, 403)
      const updated = yield* authDb.listPasskeyCredentialsForUser(
        session.userId,
      )
      return json(
        listed(
          organisationName,
          { userId: account.value.id, email: account.value.email },
          updated,
        ),
      )
    }

    const rawBody = yield* request.json.pipe(
      Effect.mapError(() => invalidRequest()),
    )
    const start = Schema.decodeUnknownEither(StartPasskeyEnrollment, {
      onExcessProperty: "error",
    })(rawBody)
    const verify = Schema.decodeUnknownEither(VerifyPasskeyEnrollment)(rawBody)

    if (Either.isRight(start) && Either.isLeft(verify)) {
      const rpConfig = yield* Schema.decodeUnknown(PasskeyProviderConfigSchema)(
        passkeyProvider.value.config,
      ).pipe(
        Effect.mapError(
          () =>
            new PasskeyManagementRequestError({
              status: 500,
              error: "internal_error",
            }),
        ),
      )
      const userHandle = getPasskeyUserHandle({
        ...account.value,
        userId: account.value.id,
      })
      const options = yield* createPasskeyRegistrationOptions({
        rpName: rpConfig.rpName,
        rpID: rpConfig.rpID,
        email: account.value.email,
        userHandle,
        excludeCredentials: credentials.map((credential) => ({
          id: credential.credentialId,
          ...(credential.transports && { transports: credential.transports }),
        })),
      })
      const challengeId = crypto.randomUUID()
      yield* withStorage(
        Storage.set(
          challengeKey(challengeId),
          {
            type: "management" as const,
            challenge: options.challenge,
            userId: session.userId,
            userHandle,
            name: start.right.name,
          },
          CHALLENGE_TTL_SECONDS,
        ),
      )
      return json({ challengeId, options })
    }

    if (Either.isLeft(verify)) return json({ error: "invalid_request" }, 400)

    const enrollment = verify.right
    const stored = yield* withStorage(
      Storage.take<unknown>(challengeKey(enrollment.challengeId)),
    )
    const challenge = Schema.decodeUnknownOption(ManagementChallenge)(stored)
    if (Option.isNone(challenge) || challenge.value.userId !== session.userId) {
      return json({ error: "invalid_request" }, 400)
    }

    const rpConfig = yield* Schema.decodeUnknown(PasskeyProviderConfigSchema)(
      passkeyProvider.value.config,
    ).pipe(
      Effect.mapError(
        () =>
          new PasskeyManagementRequestError({
            status: 500,
            error: "internal_error",
          }),
      ),
    )
    const verification = yield* verifyPasskeyRegistrationAttestation({
      origin: rpConfig.origin,
      rpID: rpConfig.rpID,
      expectedChallenge: challenge.value.challenge,
      response: enrollment.response,
    })
    if (!verification.verified) {
      return json({ error: "verification_failed" }, 400)
    }

    const persisted = yield* sql
      .withTransaction(
        withAuthDb(
          registerAdditionalPasskeyForAccount({
            userId: session.userId,
            userHandle: challenge.value.userHandle,
            name: challenge.value.name,
            credential: verification.credential,
          }),
        ),
      )
      .pipe(
        Effect.catchTag(
          "@pf/PasskeyCredentialAlreadyOwnedError",
          (_error: PasskeyCredentialAlreadyOwnedError) =>
            Effect.succeed("already_registered" as const),
        ),
        Effect.catchTag(
          "@pf/PasskeyManagementDeniedError",
          (_error: PasskeyManagementDeniedError) =>
            Effect.succeed("management_denied" as const),
        ),
        Effect.catchTag(
          "@pf/PasskeyIdentityNotFoundError",
          (_error: PasskeyIdentityNotFoundError) =>
            Effect.succeed("management_denied" as const),
        ),
      )
    if (persisted === "already_registered") {
      return json({ error: "already_registered" }, 409)
    }
    if (persisted === "management_denied") {
      return json({ error: "management_denied" }, 403)
    }

    const updated = yield* authDb.listPasskeyCredentialsForUser(session.userId)
    return json(
      listed(
        organisationName,
        { userId: account.value.id, email: account.value.email },
        updated,
      ),
    )
  }).pipe(
    Effect.catchTag("PasskeyManagementRequestError", ({ status, error }) =>
      Effect.succeed(json({ error }, status)),
    ),
    Effect.catchAll(() =>
      Effect.logError("Unexpected passkey management failure").pipe(
        Effect.as(json({ error: "internal_error" }, 500)),
      ),
    ),
  )
  return handler
})
