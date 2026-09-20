/** WebAuthn/passkey provider with application-owned credential persistence. */
import { HttpRouter, HttpServerRequest } from "@effect/platform"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/types"
import { Data, Effect, Either, Schema } from "effect"
import { json } from "../response.js"
import { Storage } from "../storage/storage.js"
import {
  type Provider,
  type ProviderOptions,
  tryProviderCallback,
} from "./provider.js"

/**
 * WebAuthn library verification failed (registration or authentication).
 * Callers typically map this to a client-facing verification failure.
 */
export class PasskeyVerificationError extends Data.TaggedError(
  "@pf/openauth/PasskeyVerificationError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

const RegistrationResponseSchema = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  type: Schema.Literal("public-key"),
  clientExtensionResults: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    attestationObject: Schema.String,
    transports: Schema.optional(Schema.Array(Schema.String)),
  }),
})

type ValidatedRegistrationResponse = Schema.Schema.Type<typeof RegistrationResponseSchema>

const toRegistrationResponseJSON = (
  response: ValidatedRegistrationResponse
): RegistrationResponseJSON => ({
  id: response.id,
  rawId: response.rawId,
  type: response.type,
  clientExtensionResults: {},
  response: {
    clientDataJSON: response.response.clientDataJSON,
    attestationObject: response.response.attestationObject,
    ...(response.response.transports && {
      transports: response.response.transports.slice() as AuthenticatorTransportFuture[],
    }),
  },
})

const AuthenticationResponseSchema = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  type: Schema.Literal("public-key"),
  clientExtensionResults: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.String,
    signature: Schema.String,
    userHandle: Schema.String,
  }),
})

type ValidatedAuthenticationResponse = Schema.Schema.Type<typeof AuthenticationResponseSchema>

const toAuthenticationResponseJSON = (
  response: ValidatedAuthenticationResponse
): AuthenticationResponseJSON => ({
  id: response.id,
  rawId: response.rawId,
  type: response.type,
  clientExtensionResults: {},
  response: {
    clientDataJSON: response.response.clientDataJSON,
    authenticatorData: response.response.authenticatorData,
    signature: response.response.signature,
    userHandle: response.response.userHandle,
  },
})

const RegisterVerifyRequestSchema = Schema.Struct({
  challengeId: Schema.String,
  response: RegistrationResponseSchema,
  /**
   * Invitation registration re-supplies the Registration Session bearer from
   * the browser cookie. Never persisted on the challenge — only its hash is.
   */
  sessionBearer: Schema.optional(Schema.String),
})

const AuthVerifyRequestSchema = Schema.Struct({
  challengeId: Schema.String,
  response: AuthenticationResponseSchema,
})

const ExchangeRegistrationLinkSchema = Schema.Struct({
  token: Schema.String,
})

export interface PasskeyCredential {
  readonly credentialId: string
  readonly publicKey: string
  readonly counter: number
  readonly transports?: readonly string[]
  readonly userHandle: string
  readonly email: string
}

export interface InvitationRegistrationSessionResolved {
  readonly registrationKind: "invitation"
  readonly email: string
  readonly invitationId: string
  readonly linkGeneration: number
  readonly sessionTokenHash: string
}

export interface RecoveryRegistrationSessionResolved {
  readonly registrationKind: "recovery"
  readonly email: string
  readonly userId: string
  readonly userHandle: string
  readonly recoveryId: string
  readonly sessionTokenHash: string
}

export interface PasskeyConfig {
  readonly rpName: string
  readonly rpID: string
  readonly origin: string | string[]
  /**
   * Authorise Passkey Open Registration for a Normalized Email.
   * Called when issuing registration options and again at verification so
   * eligibility is revalidated before success is returned to the application.
   */
  readonly canRegister: (
    email: string
  ) => Promise<{ allowed: true } | { allowed: false; error: string }>
  /**
   * Exchange a live Registration Link token for a Registration Session bearer.
   * Optional: when absent, Invitation registration endpoints return generic
   * invalid-link errors.
   */
  readonly exchangeRegistrationLink?: (
    token: string
  ) => Promise<
    | {
        ok: true
        email: string
        sessionBearer: string
        expiresAtUnixMs: number
      }
    | { ok: false; error: string }
  >
  /**
   * Resolve and revalidate a Registration Session for Invitation registration.
   * Optional: when absent, Invitation mode is unavailable.
   */
  readonly resolveInvitationRegistrationSession?: (
    sessionBearer: string
  ) => Promise<
    | {
        allowed: true
        context: InvitationRegistrationSessionResolved | RecoveryRegistrationSessionResolved
      }
    | { allowed: false; error: string }
  >
  readonly findCredential: (
    credentialId: string
  ) => Promise<PasskeyCredential | undefined>
  readonly challengeExpiry?: number
}

/**
 * Distinct server-authorised Open Registration context. Invitation bootstrap
 * uses a Registration Session instead and never reuses this shape as acceptance
 * evidence.
 */
interface OpenRegistrationChallenge {
  readonly challenge: string
  readonly email: string
  readonly userHandle: string
  readonly type: "register"
  readonly registrationKind: "open"
}

/**
 * Invitation registration challenge bound to a Registration Session snapshot.
 * Stores only the session token hash — never the raw bearer.
 */
interface InvitationRegistrationChallenge {
  readonly challenge: string
  readonly email: string
  readonly userHandle: string
  readonly type: "register"
  readonly registrationKind: "invitation"
  readonly invitationId: string
  readonly linkGeneration: number
  readonly sessionTokenHash: string
}

interface AuthenticationChallenge {
  readonly challenge: string
  readonly type: "authenticate"
}

type PasskeyChallenge =
  | OpenRegistrationChallenge
  | InvitationRegistrationChallenge
  | (RecoveryRegistrationSessionResolved & {
      readonly challenge: string
      readonly type: "register"
    })
  | AuthenticationChallenge

type OpenPasskeyRegistrationProperties = {
  readonly type: "registration"
  readonly registrationKind: "open"
  readonly email: string
  readonly userHandle: string
  readonly credential: {
    readonly id: string
    readonly publicKey: string
    readonly counter: number
    readonly transports?: readonly AuthenticatorTransportFuture[]
  }
}

type InvitationPasskeyRegistrationProperties = {
  readonly type: "registration"
  readonly registrationKind: "invitation"
  readonly email: string
  readonly userHandle: string
  readonly invitationId: string
  readonly linkGeneration: number
  readonly sessionTokenHash: string
  readonly sessionBearer: string
  readonly credential: {
    readonly id: string
    readonly publicKey: string
    readonly counter: number
    readonly transports?: readonly AuthenticatorTransportFuture[]
  }
}

export type PasskeyRegistrationProperties =
  | OpenPasskeyRegistrationProperties
  | InvitationPasskeyRegistrationProperties
  | (RecoveryRegistrationSessionResolved & {
      readonly type: "registration"
      readonly sessionBearer: string
      readonly credential: InvitationPasskeyRegistrationProperties["credential"]
    })

export interface PasskeyAuthenticationProperties {
  readonly type: "authentication"
  readonly email: string
  readonly userHandle: string
  readonly credentialId: string
  readonly previousCounter: number
  readonly newCounter: number
}

export type PasskeyProperties =
  | PasskeyRegistrationProperties
  | PasskeyAuthenticationProperties

const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

const uint8ArrayToBase64 = (array: Uint8Array): string =>
  Buffer.from(array).toString("base64url")

const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const buffer = Buffer.from(base64, "base64url")
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/** Existing credential descriptor for WebAuthn `excludeCredentials`. */
export interface PasskeyExcludeCredential {
  readonly id: string
  readonly transports?: readonly string[]
}

export const PasskeyRegistrationResponseSchema = RegistrationResponseSchema

const excludeCredentialDescriptors = (
  excludeCredentials: readonly PasskeyExcludeCredential[] | undefined,
) => {
  if (!excludeCredentials || excludeCredentials.length === 0) return undefined
  return excludeCredentials.map((credential) => ({
    id: credential.id,
    type: "public-key" as const,
    ...(credential.transports &&
      credential.transports.length > 0 && {
        transports: credential.transports.slice() as AuthenticatorTransportFuture[],
      }),
  }))
}

const issueRegistrationOptions = (
  config: Pick<PasskeyConfig, "rpName" | "rpID">,
  email: string,
  userId: Uint8Array<ArrayBuffer>,
  excludeCredentials?: readonly PasskeyExcludeCredential[],
) => {
  const excluded = excludeCredentialDescriptors(excludeCredentials)
  return Effect.promise(() =>
    generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: email,
      userDisplayName: email,
      userID: userId,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      ...(excluded && { excludeCredentials: excluded }),
    }),
  )
}

/** Decode a WebAuthn user handle stored as base64url. */
export const passkeyUserHandleBytes = (userHandle: string) =>
  base64ToUint8Array(userHandle)

/**
 * Create discoverable, user-verified registration options bound to an existing
 * account handle, excluding already-registered credentials when provided.
 */
export const createPasskeyRegistrationOptions = (input: {
  readonly rpName: string
  readonly rpID: string
  readonly email: string
  readonly userHandle: string
  readonly excludeCredentials?: readonly PasskeyExcludeCredential[]
}) =>
  issueRegistrationOptions(
    { rpName: input.rpName, rpID: input.rpID },
    input.email,
    base64ToUint8Array(input.userHandle),
    input.excludeCredentials,
  )

/**
 * Verify a registration attestation against the organisation relying party.
 * Failed library verification is reported as `{ verified: false }`.
 */
export const verifyPasskeyRegistrationAttestation = (input: {
  readonly origin: string | readonly string[]
  readonly rpID: string
  readonly expectedChallenge: string
  readonly response: Schema.Schema.Type<typeof RegistrationResponseSchema>
}) =>
  Effect.tryPromise({
    try: () =>
      verifyRegistrationResponse({
        response: toRegistrationResponseJSON(input.response),
        expectedChallenge: input.expectedChallenge,
        expectedOrigin:
          typeof input.origin === "string" ? input.origin : [...input.origin],
        expectedRPID: input.rpID,
        requireUserVerification: true,
      }),
    catch: (cause) =>
      new PasskeyVerificationError({
        message: "Passkey registration verification failed",
        cause,
      }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError("Registration verification failed").pipe(
        Effect.annotateLogs({ error }),
      ),
    ),
    Effect.map((verification) => {
      if (!verification.verified || !verification.registrationInfo) {
        return { verified: false as const }
      }
      const transports = input.response.response.transports
      return {
        verified: true as const,
        credential: {
          id: verification.registrationInfo.credential.id,
          publicKey: uint8ArrayToBase64(
            verification.registrationInfo.credential.publicKey,
          ),
          counter: verification.registrationInfo.credential.counter,
          ...(transports && { transports }),
        },
      }
    }),
    Effect.orElseSucceed(() => ({ verified: false as const })),
  )

export function PasskeyProvider(
  config: PasskeyConfig
): Provider<PasskeyProperties> {
  const challengeExpiry = config.challengeExpiry ?? 300

  return {
    type: "passkey",
    init(options: ProviderOptions<PasskeyProperties>) {
      const authorizeHandler = json({
        type: "passkey",
        endpoints: {
          registerOptions: "./register-options",
          registerVerify: "./register-verify",
          authOptions: "./auth-options",
          authVerify: "./auth-verify",
          registrationSessionExchange: "./registration-session-exchange",
        },
      })

      const exchangeRegistrationSessionHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* request.json.pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )
        const decoded = Schema.decodeUnknownEither(ExchangeRegistrationLinkSchema)(
          body,
        )
        if (Either.isLeft(decoded) || !decoded.right.token.trim()) {
          return yield* json(
            {
              error:
                "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
            },
            { status: 400 },
          )
        }

        if (!config.exchangeRegistrationLink) {
          return yield* json(
            {
              error:
                "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
            },
            { status: 400 },
          )
        }

        const result = yield* tryProviderCallback(
          "Passkey provider exchangeRegistrationLink failed",
          () => config.exchangeRegistrationLink!(decoded.right.token.trim()),
        )
        if (!result.ok) {
          return yield* json({ error: result.error }, { status: 400 })
        }

        return yield* json({
          email: result.email,
          sessionBearer: result.sessionBearer,
          expiresAt: new Date(result.expiresAtUnixMs).toISOString(),
        })
      })

      const registerOptionsHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = (yield* request.json.pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )) as Record<string, unknown> | null

        if (!body) {
          return yield* json({ error: "Invalid request body" }, { status: 400 })
        }

        const sessionBearer =
          typeof body["sessionBearer"] === "string"
            ? body["sessionBearer"].trim()
            : ""

        // Invitation registration: Registration Session bearer, no caller email.
        if (sessionBearer) {
          if (!config.resolveInvitationRegistrationSession) {
            return yield* json(
              {
                error:
                  "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
              },
              { status: 400 },
            )
          }

          // Reject caller-supplied replacement email in Invitation mode.
          if (typeof body["email"] === "string" && body["email"].trim()) {
            return yield* json(
              {
                error:
                  "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
              },
              { status: 400 },
            )
          }

          const resolved = yield* tryProviderCallback(
            "Passkey provider resolveInvitationRegistrationSession failed",
            () => config.resolveInvitationRegistrationSession!(sessionBearer),
          )
          if (!resolved.allowed) {
            return yield* json({ error: resolved.error }, { status: 400 })
          }

          const { context } = resolved
          const userId = context.registrationKind === "recovery"
            ? base64ToUint8Array(context.userHandle)
            : crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
          const userHandle = uint8ArrayToBase64(userId)
          const registrationOptions = yield* issueRegistrationOptions(
            config,
            context.email,
            userId,
          )

          const challengeId = crypto.randomUUID()
          yield* Storage.set(
            ["passkey", "challenge", challengeId],
            {
              challenge: registrationOptions.challenge,
              userHandle,
              type: "register",
              ...context,
            } satisfies PasskeyChallenge,
            challengeExpiry,
          )

          return yield* json({ challengeId, options: registrationOptions })
        }

        // Open Registration: email-based, separate from Invitation acceptance.
        if (typeof body["email"] !== "string") {
          return yield* json({ error: "Email is required" }, { status: 400 })
        }

        const email = body["email"].toLowerCase().trim()
        if (!isValidEmail(email)) {
          return yield* json({ error: "Invalid email format" }, { status: 400 })
        }

        const canRegister = yield* tryProviderCallback(
          "Passkey provider canRegister failed",
          () => config.canRegister(email),
        )
        if (canRegister.allowed === false) {
          return yield* json({ error: canRegister.error }, { status: 403 })
        }

        const userId = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
        const userHandle = uint8ArrayToBase64(userId)
        const registrationOptions = yield* issueRegistrationOptions(
          config,
          email,
          userId,
        )

        const challengeId = crypto.randomUUID()
        yield* Storage.set(
          ["passkey", "challenge", challengeId],
          {
            challenge: registrationOptions.challenge,
            email,
            userHandle,
            type: "register",
            registrationKind: "open",
          } satisfies OpenRegistrationChallenge,
          challengeExpiry,
        )

        return yield* json({ challengeId, options: registrationOptions })
      })

      const registerVerifyHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* request.json.pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )
        const decoded = Schema.decodeUnknownEither(RegisterVerifyRequestSchema)(body)
        if (Either.isLeft(decoded)) {
          return yield* json({ error: "Invalid request body" }, { status: 400 })
        }

        const challenge = yield* Storage.take<PasskeyChallenge>([
          "passkey",
          "challenge",
          decoded.right.challengeId,
        ])
        if (challenge?.type !== "register") {
          return yield* json({ error: "Invalid or expired challenge" }, { status: 400 })
        }

        // Invitation mode: raw bearer re-supplied from the browser cookie only
        // for this request; never read from challenge storage.
        let invitationSessionBearer = ""

        if (challenge.registrationKind === "open") {
          // Revalidate Open Registration eligibility bound to the context email
          // before returning verified material to the application.
          const canRegister = yield* tryProviderCallback(
            "Passkey provider canRegister failed",
            () => config.canRegister(challenge.email),
          )
          if (canRegister.allowed === false) {
            return yield* json({ error: canRegister.error }, { status: 403 })
          }
        } else if (
          challenge.registrationKind === "invitation" ||
          challenge.registrationKind === "recovery"
        ) {
          const sessionBearer =
            typeof decoded.right.sessionBearer === "string"
              ? decoded.right.sessionBearer.trim()
              : ""
          if (!sessionBearer || !config.resolveInvitationRegistrationSession) {
            return yield* json(
              {
                error:
                  "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
              },
              { status: 400 },
            )
          }
          const resolved = yield* tryProviderCallback(
            "Passkey provider resolveInvitationRegistrationSession failed",
            () => config.resolveInvitationRegistrationSession!(sessionBearer),
          )
          if (!resolved.allowed) {
            return yield* json({ error: resolved.error }, { status: 400 })
          }
          const { context } = resolved
          if (
            context.email !== challenge.email ||
            context.sessionTokenHash !== challenge.sessionTokenHash ||
            (context.registrationKind === "invitation"
              ? challenge.registrationKind !== "invitation" ||
                context.invitationId !== challenge.invitationId ||
                context.linkGeneration !== challenge.linkGeneration
              : challenge.registrationKind !== "recovery" ||
                context.recoveryId !== challenge.recoveryId ||
                context.userId !== challenge.userId ||
                context.userHandle !== challenge.userHandle)
          ) {
            return yield* json(
              {
                error:
                  "This registration link is no longer valid. Ask an administrator for a new Registration Link.",
              },
              { status: 400 },
            )
          }
          invitationSessionBearer = sessionBearer
        } else {
          return yield* json({ error: "Invalid or expired challenge" }, { status: 400 })
        }

        const response = toRegistrationResponseJSON(decoded.right.response)
        const verification = yield* Effect.tryPromise({
          try: () =>
            verifyRegistrationResponse({
              response,
              expectedChallenge: challenge.challenge,
              expectedOrigin: config.origin,
              expectedRPID: config.rpID,
              requireUserVerification: true,
            }),
          catch: (cause) =>
            new PasskeyVerificationError({
              message: "Passkey registration verification failed",
              cause,
            }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Registration verification failed").pipe(
              Effect.annotateLogs({ error }),
            ),
          ),
          Effect.orElseSucceed(() => null),
        )

        if (!verification?.verified || !verification.registrationInfo) {
          return yield* json({ error: "Verification failed" }, { status: 400 })
        }

        const transports = response.response.transports
        const credential = {
          id: verification.registrationInfo.credential.id,
          publicKey: uint8ArrayToBase64(
            verification.registrationInfo.credential.publicKey
          ),
          counter: verification.registrationInfo.credential.counter,
          ...(transports && { transports }),
        }

        if (challenge.registrationKind === "recovery") {
          return yield* options.success({
            type: "registration",
            registrationKind: "recovery",
            email: challenge.email,
            userHandle: challenge.userHandle,
            userId: challenge.userId,
            recoveryId: challenge.recoveryId,
            sessionTokenHash: challenge.sessionTokenHash,
            sessionBearer: invitationSessionBearer,
            credential,
          })
        }
        if (challenge.registrationKind === "invitation") {
          return yield* options.success({
            type: "registration",
            registrationKind: "invitation",
            email: challenge.email,
            userHandle: challenge.userHandle,
            invitationId: challenge.invitationId,
            linkGeneration: challenge.linkGeneration,
            sessionTokenHash: challenge.sessionTokenHash,
            sessionBearer: invitationSessionBearer,
            credential,
          })
        }

        return yield* options.success({
          type: "registration",
          registrationKind: "open",
          email: challenge.email,
          userHandle: challenge.userHandle,
          credential,
        })
      })
      const authOptionsHandler = Effect.gen(function* () {
        const authenticationOptions = yield* Effect.promise(() =>
          generateAuthenticationOptions({
            rpID: config.rpID,
            userVerification: "required",
          })
        )
        const challengeId = crypto.randomUUID()
        yield* Storage.set(
          ["passkey", "challenge", challengeId],
          {
            challenge: authenticationOptions.challenge,
            type: "authenticate",
          } satisfies AuthenticationChallenge,
          challengeExpiry
        )
        return yield* json({ challengeId, options: authenticationOptions })
      })

      const authVerifyHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* request.json.pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )
        const decoded = Schema.decodeUnknownEither(AuthVerifyRequestSchema)(body)
        if (Either.isLeft(decoded)) {
          return yield* json({ error: "Invalid request body" }, { status: 400 })
        }

        const challenge = yield* Storage.take<PasskeyChallenge>([
          "passkey",
          "challenge",
          decoded.right.challengeId,
        ])
        if (challenge?.type !== "authenticate") {
          return yield* json({ error: "Invalid or expired challenge" }, { status: 400 })
        }

        const response = toAuthenticationResponseJSON(decoded.right.response)
        const credential = yield* tryProviderCallback(
          "Passkey provider findCredential failed",
          () => config.findCredential(response.id),
        )
        if (!credential) {
          return yield* json({ error: "Unknown credential" }, { status: 400 })
        }
        if (response.response.userHandle !== credential.userHandle) {
          return yield* json({ error: "Credential does not match user" }, { status: 400 })
        }

        const verification = yield* Effect.tryPromise({
          try: () =>
            verifyAuthenticationResponse({
              response,
              expectedChallenge: challenge.challenge,
              expectedOrigin: config.origin,
              expectedRPID: config.rpID,
              credential: {
                id: credential.credentialId,
                publicKey: base64ToUint8Array(credential.publicKey),
                counter: credential.counter,
                ...(credential.transports && {
                  transports: credential.transports.slice() as AuthenticatorTransportFuture[],
                }),
              },
              requireUserVerification: true,
            }),
          catch: (cause) =>
            new PasskeyVerificationError({
              message: "Passkey authentication verification failed",
              cause,
            }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Authentication verification failed").pipe(
              Effect.annotateLogs({ error }),
            ),
          ),
          Effect.orElseSucceed(() => null),
        )

        if (!verification?.verified) {
          return yield* json({ error: "Verification failed" }, { status: 400 })
        }

        return yield* options.success({
          type: "authentication",
          email: credential.email,
          userHandle: credential.userHandle,
          credentialId: credential.credentialId,
          previousCounter: credential.counter,
          newCounter: verification.authenticationInfo.newCounter,
        })
      })

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeHandler),
        HttpRouter.post("/register-options", registerOptionsHandler),
        HttpRouter.post("/register-verify", registerVerifyHandler),
        HttpRouter.post("/auth-options", authOptionsHandler),
        HttpRouter.post("/auth-verify", authVerifyHandler),
        HttpRouter.post(
          "/registration-session-exchange",
          exchangeRegistrationSessionHandler,
        ),
      )
    },
  }
}
