import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
import { Data, Effect, Schema } from "effect"

export const GRAPHQL_AUDIENCE = "graphql-api"
export const PUBLIC_TODO_TOKEN_AUDIENCE = `${GRAPHQL_AUDIENCE}:public-todo`

// Public todo tokens are bearer capabilities. They can expire, but individual
// leaked tokens cannot be revoked until a server-side token registry exists.

const TokenPayloadSchema = Schema.Struct({
  v: Schema.Literal(1),
  tid: Schema.String,
  externalParticipantEmail: Schema.optional(Schema.String),
  publicCompletionInvitationAttemptId: Schema.optional(Schema.String),
  iat: Schema.Number,
  exp: Schema.Number,
  aud: Schema.Literal(PUBLIC_TODO_TOKEN_AUDIENCE),
})

export type PublicTodoTokenPayload = Schema.Schema.Type<
  typeof TokenPayloadSchema
>

class PublicTodoTokenError extends Data.TaggedError("PublicTodoTokenError")<{
  readonly message: string
}> {}

const base64UrlEncode = (data: Uint8Array) =>
  Buffer.from(data).toString("base64url")

const base64UrlDecode = (data: string) => Buffer.from(data, "base64url")

// PUBLIC_TODO_TOKEN_SECRET must have enough entropy; hashing normalizes it to
// the 32-byte AES-256 key length, it does not strengthen weak secrets.
const keyFromSecret = (secret: string) =>
  createHash("sha256").update(secret).digest()

const publicTodoTokenSecret = () => {
  const secret = process.env["PUBLIC_TODO_TOKEN_SECRET"]
  if (secret) return secret

  const nodeEnv = process.env["NODE_ENV"]
  if (nodeEnv === "development" || nodeEnv === "test") {
    return "dev-public-todo-secret"
  }

  return undefined
}

export const encryptPublicTodoToken = (
  payload: PublicTodoTokenPayload,
  secret = publicTodoTokenSecret(),
) =>
  Effect.try({
    try: () => {
      if (!secret) {
        throw new Error("PUBLIC_TODO_TOKEN_SECRET is not configured")
      }

      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv)
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8")
      const encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()

      return [iv, tag, encrypted].map(base64UrlEncode).join(".")
    },
    catch: (error) =>
      new PublicTodoTokenError({
        message:
          error instanceof Error ? error.message : "Invalid public todo token",
      }),
  })

export const decryptPublicTodoToken = (
  token: string,
  secret = publicTodoTokenSecret(),
) =>
  Effect.gen(function* () {
    if (!secret) {
      return yield* new PublicTodoTokenError({
        message: "PUBLIC_TODO_TOKEN_SECRET is not configured",
      })
    }

    const payload = yield* Effect.try({
      try: () => {
        const parts = token.split(".")
        if (parts.length !== 3) {
          throw new Error("Malformed public todo token")
        }

        const [ivPart, tagPart, encryptedPart] = parts
        if (!ivPart || !tagPart || !encryptedPart) {
          throw new Error("Malformed public todo token")
        }

        const decipher = createDecipheriv(
          "aes-256-gcm",
          keyFromSecret(secret),
          base64UrlDecode(ivPart),
        )
        decipher.setAuthTag(base64UrlDecode(tagPart))
        const decrypted = Buffer.concat([
          decipher.update(base64UrlDecode(encryptedPart)),
          decipher.final(),
        ])
        return JSON.parse(decrypted.toString("utf8")) as unknown
      },
      catch: (error) => error,
    }).pipe(
      Effect.tapError((error) =>
        Effect.logDebug("Failed to decrypt public todo token", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      Effect.mapError(
        () =>
          new PublicTodoTokenError({ message: "Invalid public todo token" }),
      ),
    )

    return yield* Schema.decodeUnknown(TokenPayloadSchema)(payload).pipe(
      Effect.tapError((error) =>
        Effect.logDebug("Invalid public todo token payload", {
          error: String(error),
        }),
      ),
      Effect.mapError(
        () =>
          new PublicTodoTokenError({ message: "Invalid public todo token" }),
      ),
    )
  })

export const buildPublicTodoUrl = (
  frontendBaseUrl: string,
  token: string,
): string => {
  const normalizedBaseUrl = frontendBaseUrl.endsWith("/")
    ? frontendBaseUrl
    : `${frontendBaseUrl}/`

  return new URL(
    `public/form/${encodeURIComponent(token)}`,
    normalizedBaseUrl,
  ).toString()
}
