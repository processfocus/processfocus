import { Clock, DateTime, Effect, Layer } from "effect"
import {
  type JWTPayload,
  SignJWT,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from "jose"
import {
  checkProviderUserAssignments,
  createAuthenticationServer,
  prepareRoleSwitch,
  providerUserAuthorityVersion,
} from "@pf/auth-api"
import { ActivePolicyRevision } from "@pf/auth-policy"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { Storage, createTestApp } from "@pf/openauth"
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
    readonly invalidState?: boolean
    readonly allowedWorkspaceDomains?: string[]
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
        ...(options.allowedWorkspaceDomains
          ? { allowedWorkspaceDomains: options.allowedWorkspaceDomains }
          : {}),
      },
    })

    if (options.existingUser) {
      const now = yield* DateTime.now
      const [user] = yield* db
        .insert(schema.user)
        .values({
          provider: "google",
          sub: String(claims.sub),
          createdAt: now,
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
      clients: [{ id: "frontend", redirectUris: [REDIRECT_URI] }],
    })
    const auth = createTestApp(issuerApp, { runtime })
    const client = createClient({
      issuer: "https://auth.example.com",
      clientID: "frontend",
      fetch: (input, init) => Promise.resolve(auth.request(input, init)),
    })
    const login = Effect.fnUntraced(function* (
      googleRevalidationSubject?: string,
      { omitAuthorizationCookie = false } = {},
    ) {
      const { challenge, url } = yield* Effect.promise(() =>
        client.authorize(REDIRECT_URI, "code", {
          pkce: true,
          provider: "google",
          googleRevalidationSubject,
        }),
      )

      const authorizationResponse = yield* Effect.promise(() =>
        auth.request(url),
      )
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
      expect(googleUrl.searchParams.get("prompt")).toBe(
        googleRevalidationSubject ? "none" : null,
      )
      expect(googleUrl.searchParams.get("login_hint")).toBe(
        googleRevalidationSubject ?? null,
      )
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
        options.invalidState
          ? "invalid-state"
          : (googleUrl.searchParams.get("state") ?? ""),
      )
      const callbackResponse = yield* Effect.promise(() =>
        auth.request(callbackUrl, {
          headers: {
            cookie: omitAuthorizationCookie
              ? providerCookie
              : `${authorizationCookie}; ${providerCookie}`,
          },
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
    return { ...(yield* login()), login }
  })

describe("auth-server Google verified human identity", () => {
  it("returns a revalidation error to the client when only the provider cookie survives", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { login } = yield* runGoogleLogin({
          sub: "returning-human",
          email: "returning@example.com",
          email_verified: true,
        })
        const { callbackResponse, challenge } = yield* login(
          "returning-human",
          {
            omitAuthorizationCookie: true,
          },
        )
        const expected = new URL(REDIRECT_URI)
        expected.searchParams.set("error", "invalid_request")
        expected.searchParams.set("state", challenge.state)
        expect(callbackResponse.status).toBe(302)
        expect(callbackResponse.headers.get("location")).toBe(expected.href)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("bounds refresh rotation, role switching and CLI export to the original upstream callback", async () => {
    let now = Date.now()
    const clock = Object.assign(
      Object.create(Effect.runSync(Clock.Clock)) as Clock.Clock,
      {
        currentTimeMillisUnsafe: () => now,
        currentTimeMillis: Effect.sync(() => now),
      },
    )
    const policy = Layer.succeed(ActivePolicyRevision, {
      current: Effect.succeed("sso-test-policy"),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const behavior = { invalidNonce: false }
        const googleClaims = {
          sub: "bounded-human",
          email: "bounded@example.com",
          email_verified: true,
        }
        const result = yield* runGoogleLogin(googleClaims, behavior)
        const exchange = (response: typeof result) =>
          Effect.promise(() =>
            result.client.exchange(
              new URL(
                response.callbackResponse.headers.get("location")!,
              ).searchParams.get("code")!,
              REDIRECT_URI,
              response.challenge.verifier,
            ),
          )
        const initial = yield* exchange(result)
        if (initial.err) throw initial.err
        expect((yield* exchange(result)).err).not.toBe(false)
        const verified = yield* Effect.promise(() =>
          result.client.verify(subjects, initial.tokens.access),
        )
        if (verified.err || verified.subject.type !== "providerUser")
          throw new Error("Expected human session")
        const session = verified.subject.properties
        const parts = initial.tokens.refresh.split(":")
        const token = parts.pop()!
        const subject = parts.join(":")
        const stored = yield* Storage.get<Record<string, unknown>>([
          "oauth:refresh",
          subject,
          token,
        ])
        expect(stored).toBeDefined()
        const legacyToken = crypto.randomUUID()
        yield* Storage.set(
          ["oauth:refresh", subject, legacyToken],
          {
            ...stored,
            properties: { ...session, sso: undefined },
            expiresAt: undefined,
          },
          3600,
        )
        expect(
          (yield* Effect.promise(() =>
            result.client.refresh(`${subject}:${legacyToken}`),
          )).err,
        ).not.toBe(false)
        const deadline = now + 8 * 60 * 60 * 1000
        expect(session.sso).toEqual({
          provider: "google",
          subject: "bounded-human",
          verifiedAt: now,
          expiresAt: deadline,
        })
        expect(yield* checkProviderUserAssignments(session)).toBe(true)
        expect(
          yield* checkProviderUserAssignments({
            ...session,
            sso: {
              provider: "google",
              subject: "another-human",
              verifiedAt: now,
              expiresAt: deadline,
            },
          }),
        ).toBe(false)
        expect(
          yield* checkProviderUserAssignments({ ...session, sso: undefined }),
        ).toBe(false)
        const [role] = yield* result.db
          .insert(schema.role)
          .values({
            name: "Tester",
            path: "/Tester",
            orgUnitId: session.orgUnitId,
          })
          .returning()
        const [providerUser] = yield* result.db
          .select()
          .from(schema.providerUser)
        yield* result.db
          .insert(schema.providerUserRole)
          .values({ providerUserId: providerUser!.id, roleId: role!.id })
        yield* prepareRoleSwitch(
          session,
          "/Tester",
          yield* providerUserAuthorityVersion(session.userId),
        )
        const switched = yield* Effect.promise(() =>
          result.client.refresh(initial.tokens.refresh, {
            scope: "role:%2FTester",
          }),
        )
        if (switched.err || !switched.tokens)
          throw new Error("Role refresh failed")
        expect(decodeJwt(switched.tokens.access)["properties"]).toMatchObject({
          sso: session.sso,
          roles: ["/Tester"],
        })
        now = deadline - 10_000
        const cli = yield* Effect.promise(() =>
          result.client.refresh(switched.tokens!.refresh, { scope: "cli" }),
        )
        if (cli.err || !cli.tokens) throw new Error("CLI refresh failed")
        expect(cli.tokens.expiresIn).toBeLessThanOrEqual(10)
        expect(cli.tokens.expiresIn).toBeGreaterThan(0)
        expect(decodeJwt(cli.tokens.access).exp).toBe(
          Math.floor(deadline / 1000),
        )
        expect(decodeJwt(cli.tokens.access)["properties"]).toMatchObject({
          sso: session.sso,
        })
        now = deadline
        expect(yield* checkProviderUserAssignments(session)).toBe(false)
        const expired = yield* Effect.promise(() =>
          result.client.refresh(cli.tokens!.refresh),
        )
        expect(expired.err).not.toBe(false)
        now += 1
        behavior.invalidNonce = true
        const invalid = yield* result.login("bounded-human")
        expect(
          new URL(
            invalid.callbackResponse.headers.get("location")!,
          ).searchParams.get("error"),
        ).toBe("invalid_request")
        expect(
          (yield* Effect.promise(() =>
            result.client.refresh(cli.tokens!.refresh),
          )).err,
        ).not.toBe(false)
        behavior.invalidNonce = false
        // Google can return a valid, nonce-bound response for the wrong user.
        // The issuer must not produce a PF authorization code for that account.
        googleClaims.sub = "a-different-google-subject"
        const wrongAccount = yield* result.login("bounded-human")
        const wrongDestination = new URL(
          wrongAccount.callbackResponse.headers.get("location")!,
        )
        expect(wrongDestination.searchParams.get("error")).toBe("access_denied")
        expect(wrongDestination.searchParams.get("code")).toBeNull()
        googleClaims.sub = "bounded-human"
        const fresh = yield* result.login("bounded-human")
        const renewed = yield* exchange({ ...result, ...fresh })
        if (renewed.err) throw renewed.err
        expect(decodeJwt(renewed.tokens.access)["properties"]).toMatchObject({
          sso: { verifiedAt: now, expiresAt: now + 8 * 60 * 60 * 1000 },
        })
        expect(
          (yield* Effect.promise(() =>
            result.client.refresh(cli.tokens!.refresh),
          )).err,
        ).not.toBe(false)
      }).pipe(
        Effect.provide(TestLayer),
        Effect.provide(policy),
        Effect.provideService(Clock.Clock, clock),
      ),
    )
  })

  it.each([undefined, "other.example.com", "example.com"])(
    "checks signed Workspace membership (%s)",
    async (hd) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { callbackResponse, db, login } = yield* runGoogleLogin(
            {
              sub: "workspace-user",
              email: "user@example.com",
              email_verified: true,
              ...(hd ? { hd } : {}),
            },
            { allowedWorkspaceDomains: ["example.com"] },
          )
          expect(callbackResponse.status).toBe(hd === "example.com" ? 302 : 403)
          const revalidated = yield* login("workspace-user")
          const location = new URL(
            revalidated.callbackResponse.headers.get("location")!,
          )
          expect(location.searchParams.get("error")).toBe(
            hd === "example.com" ? null : "access_denied",
          )
          expect(location.searchParams.has("code")).toBe(hd === "example.com")
          expect((yield* db.select().from(schema.providerUser)).length).toBe(
            hd === "example.com" ? 1 : 0,
          )
        }).pipe(Effect.provide(TestLayer)),
      )
    },
  )
  it.each(["authentication", "audit"])(
    "preserves the commit boundary when %s persistence fails",
    async (failure) => {
      const logs: string[] = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const table =
            failure === "authentication" ? "pf_provider_user" : "pf_audit_event"
          yield* sql.unsafe(
            `CREATE TRIGGER unavailable BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'unavailable'); END`,
          )
          const { callbackResponse, db } = yield* runGoogleLogin({
            sub: "google-failure-probe",
            email: "failure@example.com",
            email_verified: true,
          })
          const users = yield* db.select().from(schema.user)
          expect(users).toHaveLength(failure === "authentication" ? 0 : 1)
          expect(yield* db.select().from(schema.auditEvent)).toEqual([])
          const auditLogs = logs.filter(
            (message) =>
              message.includes("Audit event") ||
              message.includes("Audit delivery"),
          )
          if (failure === "audit") {
            expect(
              new URL(
                callbackResponse.headers.get("location")!,
              ).searchParams.get("code"),
            ).not.toBeNull()
            expect(auditLogs).toHaveLength(2)
            expect(auditLogs[0]).toContain('"authenticationMethod":"oauth"')
            expect(auditLogs[1]).toContain("delivery failed or timed out")
            expect(auditLogs.join()).not.toContain("test-google-secret")
          } else {
            expect(auditLogs).toEqual([])
          }
          yield* sql.unsafe("DROP TRIGGER unavailable")
          yield* sql.withTransaction(
            sql.unsafe("UPDATE pf_org_unit SET name = 'Usable'"),
          )
        }).pipe(
          Effect.provide(TestLayer),
          Effect.provide(
            Logger.layer([
              Logger.make((entry) => {
                logs.push(JSON.stringify(entry.message))
              }),
            ]),
          ),
        ),
      )
    },
  )
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
          const audits = yield* db.select().from(schema.auditEvent)
          expect(audits).toHaveLength(1)
          expect(audits[0]).toMatchObject({
            auditKind: "login",
            auditDetails: {
              actorUserId: providerUsers[0]!.userId,
              authenticationMethod: "oauth",
            },
          })
          const queries = yield* SettingsQueries
          const users = yield* queries.queryAllUsers(1, 10)
          expect(users.totalCount).toBe(1)
          expect(users.items[0]!.lastLoggedIn.getTime()).toBe(
            DateTime.toEpochMillis(audits[0]!.occurredAt),
          )
          expect(
            (yield* queries.queryUserDetail(providerUsers[0]!.userId))!
              .lastLoggedIn,
          ).toEqual(users.items[0]!.lastLoggedIn)
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
            expect(yield* db.select().from(schema.auditEvent)).toHaveLength(0)
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

  it.each(["nonce", "state"])(
    "rejects identity production when the OIDC %s is invalid",
    async (invalid) => {
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
              {
                invalidNonce: invalid === "nonce",
                invalidState: invalid === "state",
              },
            )

            expect(callbackResponse.status).toBe(
              invalid === "nonce" ? 500 : 400,
            )
            expect(callbackResponse.headers.get("location")).toBeNull()
            expect(yield* db.select().from(schema.user)).toHaveLength(0)
            expect(yield* db.select().from(schema.providerUser)).toHaveLength(0)
          }),
          TestLayer,
        ),
      )
    },
  )

  it("signs in an existing Provider User without verified-email evidence", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { callbackResponse, db } = yield* runGoogleLogin(
            {
              sub: "google-existing-user",
              email: "asserted@example.com",
              name: "Asserted User",
              picture: "https://example.com/new-picture.png",
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
          expect(providerUsers[0]?.picture).toBe(
            "https://example.com/new-picture.png",
          )
        }),
        TestLayer,
      ),
    )
  })
})

import { Logger } from "effect"
import { SqlClient } from "effect/sql"
