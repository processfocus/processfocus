/**
 * Cryptographic helpers for Invitation Registration Link tokens.
 *
 * Tokens are 32-byte bearer secrets. Persistence stores only:
 * - SHA-256(token) as base64url for constant-shape lookup
 * - AES-256-GCM encrypted envelope for authorised re-reveal
 *
 * Key material comes from INVITATION_REGISTRATION_ENCRYPTION_KEY and is
 * domain-separated so this protocol remains isolated from other token uses.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { Data, Effect } from "effect"

export const REGISTRATION_LINK_ENCRYPTION_VERSION = 1
export const REGISTRATION_LINK_TTL_DAYS = 7
export const REGISTRATION_LINK_TOKEN_BYTES = 32

export class RegistrationLinkCryptoError extends Data.TaggedError(
  "RegistrationLinkCryptoError",
)<{
  readonly message: string
}> {}

export type RegistrationLinkEnvelope = {
  readonly encryptionVersion: number
  readonly nonce: string
  readonly authenticationTag: string
  readonly ciphertext: string
}

export type RegistrationLinkMaterial = {
  readonly rawToken: string
  readonly tokenHash: string
  readonly envelope: RegistrationLinkEnvelope
}

const KEY_DOMAIN = "process-focus:invitation-registration:v1\0"
export const DEVELOPMENT_INVITATION_REGISTRATION_SECRET =
  "dev-invitation-registration-secret"

const invitationRegistrationSecret = (): string | undefined => {
  const secret = process.env["INVITATION_REGISTRATION_ENCRYPTION_KEY"]
  if (secret) return secret

  const nodeEnv = process.env["NODE_ENV"]
  if (nodeEnv === "development" || nodeEnv === "test") {
    return DEVELOPMENT_INVITATION_REGISTRATION_SECRET
  }

  return undefined
}

const decodeRawKey = (secret: string): Buffer => {
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Buffer.from(secret, "hex")
  }
  try {
    const asBase64 = Buffer.from(secret, "base64")
    if (asBase64.length === 32) {
      return asBase64
    }
  } catch {
    // Fall through to UTF-8 secret hashing.
  }
  // Enough entropy is the operator's responsibility; hashing only normalises
  // length for AES-256.
  return createHash("sha256").update(secret).digest()
}

export const deriveRegistrationLinkKey = (
  secret = invitationRegistrationSecret(),
): Effect.Effect<Buffer, RegistrationLinkCryptoError> =>
  Effect.try({
    try: () => {
      if (!secret) {
        throw new Error(
          "INVITATION_REGISTRATION_ENCRYPTION_KEY is not configured",
        )
      }
      const raw = decodeRawKey(secret)
      return createHash("sha256").update(KEY_DOMAIN).update(raw).digest()
    },
    catch: (error) =>
      new RegistrationLinkCryptoError({
        message:
          error instanceof Error
            ? error.message
            : "Invitation registration encryption is not configured correctly",
      }),
  })

export const hashRegistrationLinkToken = (rawToken: string): string =>
  createHash("sha256")
    .update(Buffer.from(rawToken, "base64url"))
    .digest("base64url")

export const registrationLinkAad = (input: {
  readonly organisationScope: string
  readonly invitationId: string
  readonly tokenHash: string
  readonly expiresAtUnixMs: number
}): Buffer =>
  Buffer.from(
    JSON.stringify([
      REGISTRATION_LINK_ENCRYPTION_VERSION,
      input.organisationScope,
      input.invitationId,
      input.tokenHash,
      input.expiresAtUnixMs,
    ]),
    "utf8",
  )

export const generateRegistrationLinkMaterial = (input: {
  readonly organisationScope: string
  readonly invitationId: string
  readonly expiresAtUnixMs: number
  readonly secret?: string
}): Effect.Effect<RegistrationLinkMaterial, RegistrationLinkCryptoError> =>
  Effect.gen(function* () {
    const key = yield* deriveRegistrationLinkKey(input.secret)
    const rawBytes = randomBytes(REGISTRATION_LINK_TOKEN_BYTES)
    const rawToken = rawBytes.toString("base64url")
    const tokenHash = createHash("sha256").update(rawBytes).digest("base64url")

    const envelope = yield* Effect.try({
      try: () => {
        const nonce = randomBytes(12)
        const cipher = createCipheriv("aes-256-gcm", key, nonce)
        cipher.setAAD(
          registrationLinkAad({
            organisationScope: input.organisationScope,
            invitationId: input.invitationId,
            tokenHash,
            expiresAtUnixMs: input.expiresAtUnixMs,
          }),
        )
        const ciphertext = Buffer.concat([
          cipher.update(rawBytes),
          cipher.final(),
        ])
        return {
          encryptionVersion: REGISTRATION_LINK_ENCRYPTION_VERSION,
          nonce: nonce.toString("base64url"),
          authenticationTag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
        } satisfies RegistrationLinkEnvelope
      },
      catch: () =>
        new RegistrationLinkCryptoError({
          message: "Failed to encrypt registration link token",
        }),
    })

    return { rawToken, tokenHash, envelope }
  })

export const decryptRegistrationLinkToken = (input: {
  readonly organisationScope: string
  readonly invitationId: string
  readonly tokenHash: string
  readonly expiresAtUnixMs: number
  readonly envelope: RegistrationLinkEnvelope
  readonly secret?: string
}): Effect.Effect<string, RegistrationLinkCryptoError> =>
  Effect.gen(function* () {
    const key = yield* deriveRegistrationLinkKey(input.secret)

    if (
      input.envelope.encryptionVersion !== REGISTRATION_LINK_ENCRYPTION_VERSION
    ) {
      return yield* new RegistrationLinkCryptoError({
        message: "Unsupported registration link encryption version",
      })
    }

    const rawBytes = yield* Effect.try({
      try: () => {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(input.envelope.nonce, "base64url"),
        )
        decipher.setAAD(
          registrationLinkAad({
            organisationScope: input.organisationScope,
            invitationId: input.invitationId,
            tokenHash: input.tokenHash,
            expiresAtUnixMs: input.expiresAtUnixMs,
          }),
        )
        decipher.setAuthTag(
          Buffer.from(input.envelope.authenticationTag, "base64url"),
        )
        return Buffer.concat([
          decipher.update(Buffer.from(input.envelope.ciphertext, "base64url")),
          decipher.final(),
        ])
      },
      catch: () =>
        new RegistrationLinkCryptoError({
          message: "Failed to decrypt registration link token",
        }),
    })

    const expectedHash = createHash("sha256").update(rawBytes).digest()
    const storedHash = Buffer.from(input.tokenHash, "base64url")
    if (
      expectedHash.length !== storedHash.length ||
      !timingSafeEqual(expectedHash, storedHash)
    ) {
      return yield* new RegistrationLinkCryptoError({
        message: "Registration link token integrity check failed",
      })
    }

    return rawBytes.toString("base64url")
  })

export const buildRegistrationLinkUrl = (
  frontendOrigin: string,
  rawToken: string,
): string => {
  const origin = frontendOrigin.replace(/\/$/, "")
  return `${origin}/register/passkey#token=${rawToken}`
}
