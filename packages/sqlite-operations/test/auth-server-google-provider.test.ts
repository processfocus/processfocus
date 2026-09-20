import { DateTime, Effect } from "effect"
import { type JWTPayload, SignJWT, exportJWK, generateKeyPair } from "jose"
import { createAuthenticationServer } from "@pf/auth-api"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const GOOGLE_CLIENT_ID = "test-google-client-id"
const REDIRECT_URI = "https://test.example.com/callback"

const cookieValue = (setCookie: string | null): string => {
  if (!setCookie) throw new Error("Expected Set-Cookie header")
  const [value] = setCookie.split(";")
  if (!value) throw new Error("Expected cookie value")
  return value
}

const runGoogleLogin = (
  claims: JWTPayload,
  options: {
    readonly existingUser?: boolean
    readonly invalidNonce?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const [root] = yield* db
      .insert(schema.orgUnit)
      .values({
        name: "Root Organization",
        orgUnitLevel: "root",
        path: "/",
        parentOrgUnitId: null,
      })
      .returning()
    if (!root) throw new Error("Failed to create root org unit")

    yield* db.insert(schema.oauthProvider).values({
      providerName: "google",
      providerConfig: {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: "test-google-secret",
        scopes: ["openid", "email", "profile"],
        inviteOnly: false,
      },
    })

    if (options.existingUser) {
      const now = yield* DateTime.now
      const [user] = yield* db
        .insert(schema.user)
        .values({
          provider: "google",
          sub: String(claims.sub),
          lastLoggedIn: now,
        })
        .returning()
      if (!user) throw new Error("Failed to create existing user")
      yield* db.insert(schema.providerUser).values({
        userId: user.id,
        email: "existing@example.com",
        name: "Existing User",
        firstName: "Existing",
        lastName: "User",
        picture: "",
        locale: "en",
        orgUnitId: root.id,
      })
    }

    const { app: issuerApp, runtime } = yield* createAuthenticationServer({
      clients: [{ id: "test-client", redirectUris: [REDIRECT_URI] }],
    })
    const auth = createTestApp(issuerApp, { runtime })
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "test-client",
      fetch: (input, init) => Promise.resolve(auth.request(input, init)),
    })
    const { challenge, url } = yield* Effect.promise(() =>
      client.authorize(REDIRECT_URI, "code", {
        pkce: true,
        provider: "google",
      }),
    )

    const authorizationResponse = yield* Effect.promise(() => auth.request(url))
    const authorizationCookie = cookieValue(
      authorizationResponse.headers.get("set-cookie"),
    )
    const providerResponse = yield* Effect.promise(() =>
      auth.request(authorizationResponse.headers.get("location") ?? "", {
        headers: { cookie: authorizationCookie },
      }),
    )
    const providerCookie = cookieValue(
      providerResponse.headers.get("set-cookie"),
    )
    const googleUrl = new URL(providerResponse.headers.get("location") ?? "")
    const nonce = googleUrl.searchParams.get("nonce")
    expect(nonce).not.toBeNull()

    const { privateKey, publicKey } = yield* Effect.promise(() =>
      generateKeyPair("RS256"),
    )
    const publicJwk = yield* Effect.promise(() => exportJWK(publicKey))
    const idToken = yield* Effect.promise(() =>
      new SignJWT({
        ...claims,
        nonce: options.invalidNonce ? "invalid-nonce" : nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
        .setIssuer("https://accounts.google.com")
        .setAudience(GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
    )

    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (requestUrl === "https://oauth2.googleapis.com/token") {
          return Promise.resolve(
            Response.json({
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3600,
              id_token: idToken,
            }),
          )
        }
        if (requestUrl === "https://www.googleapis.com/oauth2/v3/certs") {
          return Promise.resolve(
            Response.json({
              keys: [
                {
                  ...publicJwk,
                  alg: "RS256",
                  kid: "google-test-key",
                  use: "sig",
                },
              ],
            }),
          )
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    )

    const callbackUrl = new URL(
      googleUrl.searchParams.get("redirect_uri") ?? "",
    )
    callbackUrl.searchParams.set("code", "google-code")
    callbackUrl.searchParams.set(
      "state",
      googleUrl.searchParams.get("state") ?? "",
    )
    const callbackResponse = yield* Effect.promise(() =>
      auth.request(callbackUrl, {
        headers: { cookie: `${authorizationCookie}; ${providerCookie}` },
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = originalFetch
        }),
      ),
    )

    return { callbackResponse, challenge, client, db }
  })

describe("auth-server Google verified human identity", () => {
  it("normalizes a verified email and completes sign-in", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, challenge, client, db } =
            yield* runGoogleLogin({
              sub: "google-verified-user",
              email: "  Verified.User@Example.COM  ",
              email_verified: true,
              name: "Verified User",
              given_name: "Verified",
              family_name: "User",
            })

          expect(callbackResponse.status).toBe(302)
          const callbackLocation = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          const code = callbackLocation.searchParams.get("code")
          expect(code).not.toBeNull()

          const exchanged = yield* Effect.promise(() =>
            client.exchange(code ?? "", REDIRECT_URI, challenge.verifier),
          )
          expect(exchanged.err).toBe(false)
          if (exchanged.err) throw exchanged.err
          const verified = yield* Effect.promise(() =>
            client.verify(subjects, exchanged.tokens.access),
          )
          if (verified.err) throw verified.err
          expect(verified.subject.type).toBe("providerUser")
          if (verified.subject.type !== "providerUser")
            throw new Error("Expected provider user")
          expect(verified.subject.properties.humanSession).toBe(true)
          expect(
            verified.subject.properties.humanAuthentication,
          ).toBeUndefined()

          const providerUsers = yield* db.select().from(schema.providerUser)
          expect(providerUsers).toHaveLength(1)
          expect(providerUsers[0]?.email).toBe("verified.user@example.com")
        }),
        TestLayer,
      ),
    )
  })

  for (const emailVerified of [undefined, false] as const) {
    it(`rejects first-user creation when email_verified is ${String(emailVerified)}`, async () => {
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const { callbackResponse, db } = yield* runGoogleLogin({
              sub: `google-unverified-${String(emailVerified)}`,
              email: "unverified@example.com",
              ...(emailVerified === undefined
                ? {}
                : { email_verified: emailVerified }),
              name: "Unverified User",
            })

            expect(callbackResponse.status).toBe(302)
            const callbackLocation = new URL(
              callbackResponse.headers.get("location") ?? "",
            )
            expect(callbackLocation.searchParams.get("error")).toBe(
              "access_denied",
            )
            expect(yield* db.select().from(schema.user)).toHaveLength(0)
            expect(yield* db.select().from(schema.providerUser)).toHaveLength(0)
          }),
          TestLayer,
        ),
      )
    })
  }

  it("rejects first-user creation when a verified claim has an invalid email", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGoogleLogin({
            sub: "google-invalid-email",
            email: "not-an-email",
            email_verified: true,
            name: "Invalid Email User",
          })

          expect(callbackResponse.status).toBe(302)
          const callbackLocation = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          expect(callbackLocation.searchParams.get("error")).toBe(
            "access_denied",
          )
          expect(yield* db.select().from(schema.user)).toHaveLength(0)
          expect(yield* db.select().from(schema.providerUser)).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })

  it("rejects identity production when the OIDC nonce is invalid", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGoogleLogin(
            {
              sub: "google-invalid-nonce",
              email: "verified@example.com",
              email_verified: true,
              name: "Invalid Nonce User",
            },
            { invalidNonce: true },
          )

          expect(callbackResponse.status).toBe(500)
          expect(yield* db.select().from(schema.user)).toHaveLength(0)
          expect(yield* db.select().from(schema.providerUser)).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })

  it("signs in an existing Provider User without verified-email evidence", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGoogleLogin(
            {
              sub: "google-existing-user",
              email: "asserted@example.com",
              name: "Asserted User",
            },
            { existingUser: true },
          )

          expect(callbackResponse.status).toBe(302)
          const callbackLocation = new URL(
            callbackResponse.headers.get("location") ?? "",
          )
          expect(callbackLocation.searchParams.get("code")).not.toBeNull()
          const providerUsers = yield* db.select().from(schema.providerUser)
          expect(providerUsers).toHaveLength(1)
          expect(providerUsers[0]?.email).toBe("existing@example.com")
        }),
        TestLayer,
      ),
    )
  })
})
