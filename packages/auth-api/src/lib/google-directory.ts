import { Data, Effect, Schema } from "effect"
import { SignJWT, importPKCS8 } from "jose"

/**
 * Error from Google Directory API operations.
 */
class GoogleDirectoryError extends Data.TaggedError(
  "@pf/GoogleDirectoryError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Schema for the decoded service account key JSON.
 */
const ServiceAccountKeySchema = Schema.Struct({
  client_email: Schema.String,
  private_key: Schema.String,
})

/**
 * Schema for Google OAuth2 token response.
 */
const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
})

/**
 * Schema for Google Directory API user response.
 */
const DirectoryUserResponseSchema = Schema.Struct({
  orgUnitPath: Schema.optionalWith(Schema.String, { exact: true }),
})

/**
 * Fetch a user's organizational unit path from the Google Directory API.
 *
 * Uses domain-wide delegation via a service account to call the
 * Admin SDK Directory API.
 *
 * @param email - The user's email address to look up
 * @param serviceAccountKeyBase64 - Base64-encoded JSON service account key
 * @param adminEmail - Workspace admin email for domain-wide delegation
 * @returns The user's orgUnitPath, or undefined if not found
 */
export const fetchUserOrgUnitPath = (
  email: string,
  serviceAccountKeyBase64: string,
  adminEmail: string,
): Effect.Effect<string | undefined, GoogleDirectoryError> =>
  Effect.gen(function* () {
    // Decode base64 service account key
    const keyJson = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Unknown),
    )(atob(serviceAccountKeyBase64)).pipe(
      Effect.mapError(
        (e) =>
          new GoogleDirectoryError({
            message: "Failed to decode service account key",
            cause: e,
          }),
      ),
    )

    const key = yield* Schema.decodeUnknown(ServiceAccountKeySchema)(
      keyJson,
    ).pipe(
      Effect.mapError(
        (e) =>
          new GoogleDirectoryError({
            message: "Invalid service account key format",
            cause: e,
          }),
      ),
    )

    // Import private key and sign JWT for token exchange
    const privateKey = yield* Effect.tryPromise({
      try: () => importPKCS8(key.private_key, "RS256"),
      catch: (e) =>
        new GoogleDirectoryError({
          message: "Failed to import private key",
          cause: e,
        }),
    })

    const now = Math.floor(Date.now() / 1000)
    const jwt = yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          iss: key.client_email,
          sub: adminEmail,
          scope:
            "https://www.googleapis.com/auth/admin.directory.user.readonly",
          aud: "https://oauth2.googleapis.com/token",
          iat: now,
          exp: now + 3600,
        })
          .setProtectedHeader({ alg: "RS256", typ: "JWT" })
          .sign(privateKey),
      catch: (e) =>
        new GoogleDirectoryError({
          message: "Failed to sign JWT",
          cause: e,
        }),
    })

    // Exchange JWT for access token
    const tokenResponse = yield* Effect.tryPromise({
      try: () =>
        fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt,
          }),
        }).then((r) => r.json()),
      catch: (e) =>
        new GoogleDirectoryError({
          message: "Failed to exchange JWT for access token",
          cause: e,
        }),
    })

    const token = yield* Schema.decodeUnknown(TokenResponseSchema)(
      tokenResponse,
    ).pipe(
      Effect.mapError(
        (e) =>
          new GoogleDirectoryError({
            message: "Invalid token response from Google",
            cause: e,
          }),
      ),
    )

    // Fetch user's org unit path from Directory API
    const userResponse = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?fields=orgUnitPath`,
          {
            headers: { Authorization: `Bearer ${token.access_token}` },
          },
        ).then((r) => {
          if (r.status === 404) return { orgUnitPath: undefined }
          if (!r.ok)
            throw new Error(`Directory API returned status ${r.status}`)
          return r.json()
        }),
      catch: (e) =>
        new GoogleDirectoryError({
          message: "Failed to fetch user from Directory API",
          cause: e,
        }),
    })

    const user = yield* Schema.decodeUnknown(DirectoryUserResponseSchema)(
      userResponse,
    ).pipe(
      Effect.mapError(
        (e) =>
          new GoogleDirectoryError({
            message: "Invalid Directory API response",
            cause: e,
          }),
      ),
    )

    return user.orgUnitPath
  })
