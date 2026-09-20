import { SqlClient } from "@effect/sql"
import { and, eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Option } from "effect"
import {
  AuthenticationDatabase,
  INVITATION_REGISTRATION_INVALID_MESSAGE,
  PasskeyInvitationRegistrationDeniedError,
  createAuthenticationServer,
  registerProviderUserByPasskey,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import {
  generateRegistrationLinkMaterial,
  hashRegistrationLinkToken,
} from "@pf/graphql-schema"
import { createTestApp } from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

describe("auth-server Invitation Registration from Registration Link", () => {
  const insertPasskeyProvider = () =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* db.insert(schema.oauthProvider).values({
        providerName: "passkey",
        providerConfig: {
          rpName: "Test App",
          rpID: "example.com",
          origin: "https://example.com",
          inviteOnly: true,
        },
      })
    })

  const createAuthApp = () =>
    Effect.gen(function* () {
      const { app, runtime } = yield* createAuthenticationServer({
        clients: [
          {
            id: "test-client",
            redirectUris: ["https://test.example.com/callback"],
          },
        ],
      })
      return createTestApp(app, { runtime })
    })

  const storeLiveLink = (invitationId: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const expiresAt = DateTime.add(now, { days: 7 })
      const material = yield* generateRegistrationLinkMaterial({
        organisationScope: "test-org",
        invitationId,
        expiresAtUnixMs: DateTime.toEpochMillis(expiresAt),
      })
      const db = yield* TypedSqliteDrizzle
      yield* db
        .update(schema.invitation)
        .set({
          registrationTokenHash: material.tokenHash,
          registrationEncryptionVersion: material.envelope.encryptionVersion,
          registrationEncryptionNonce: material.envelope.nonce,
          registrationAuthenticationTag: material.envelope.authenticationTag,
          registrationEncryptedToken: material.envelope.ciphertext,
          registrationLinkExpiresAt: expiresAt,
          registrationLinkGeneratedAt: now,
          registrationLinkGeneratedBy: "admin@example.com",
          registrationLinkGeneration: 1,
          updatedAt: now,
        })
        .where(eq(schema.invitation.id, invitationId))
      return material.rawToken
    })

  const exchange = (
    auth: { request: (url: string, init?: RequestInit) => Promise<Response> },
    token: string,
  ) =>
    Effect.promise(() =>
      auth.request(
        "https://auth.example.com/oauth/passkey/registration-session-exchange",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        },
      ),
    )

  it("exchanges a live Registration Link for a Registration Session", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "invitee@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)

          const auth = yield* createAuthApp()
          const response = yield* exchange(auth, rawToken)
          expect(response.status).toBe(200)
          const body = (yield* Effect.promise(() => response.json())) as {
            email: string
            sessionBearer: string
            expiresAt: string
          }
          expect(body.email).toBe(email)
          expect(body.sessionBearer.length).toBeGreaterThan(20)
          expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())

          // Only hash is stored — no raw bearer in the table.
          const db = yield* TypedSqliteDrizzle
          const sessions = yield* db
            .select({
              hash: schema.registrationSession.registrationSessionTokenHash,
            })
            .from(schema.registrationSession)
            .where(eq(schema.registrationSession._deleted, false))
          expect(sessions).toHaveLength(1)
          expect(sessions[0]?.hash).not.toBe(body.sessionBearer)
          expect(sessions[0]?.hash).toBe(
            hashRegistrationLinkToken(body.sessionBearer),
          )
        }),
        TestLayer,
      ),
    )
  })

  it("rejects unknown, expired, and revoked links with one public error", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "bad-link@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const auth = yield* createAuthApp()

          const unknown = yield* exchange(auth, "not-a-real-token-value!!!!")
          expect(unknown.status).toBe(400)
          expect(
            ((yield* Effect.promise(() => unknown.json())) as { error: string })
              .error,
          ).toBe(INVITATION_REGISTRATION_INVALID_MESSAGE)

          const rawToken = yield* storeLiveLink(setup.invitationId)
          const db = yield* TypedSqliteDrizzle
          const now = yield* DateTime.now
          // Expire the link.
          yield* db
            .update(schema.invitation)
            .set({
              registrationLinkExpiresAt: DateTime.add(now, { hours: -1 }),
            })
            .where(eq(schema.invitation.id, setup.invitationId))

          const expired = yield* exchange(auth, rawToken)
          expect(expired.status).toBe(400)
          expect(
            ((yield* Effect.promise(() => expired.json())) as { error: string })
              .error,
          ).toBe(INVITATION_REGISTRATION_INVALID_MESSAGE)

          // Restore expiry then revoke.
          const liveToken = yield* storeLiveLink(setup.invitationId)
          yield* db
            .update(schema.invitation)
            .set({
              registrationTokenHash: null,
              registrationLinkGeneration: 2,
              registrationLinkRevokedAt: now,
            })
            .where(eq(schema.invitation.id, setup.invitationId))

          const revoked = yield* exchange(auth, liveToken)
          expect(revoked.status).toBe(400)
          expect(
            ((yield* Effect.promise(() => revoked.json())) as { error: string })
              .error,
          ).toBe(INVITATION_REGISTRATION_INVALID_MESSAGE)
        }),
        TestLayer,
      ),
    )
  })

  it("issues invitation registration options from a session without caller email", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "options@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)
          const auth = yield* createAuthApp()

          const exchangeResponse = yield* exchange(auth, rawToken)
          const { sessionBearer } = (yield* Effect.promise(() =>
            exchangeResponse.json(),
          )) as {
            sessionBearer: string
          }

          const withEmail = yield* Effect.promise(() =>
            auth.request(
              "https://auth.example.com/oauth/passkey/register-options",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionBearer,
                  email: "attacker@example.com",
                }),
              },
            ),
          )
          expect(withEmail.status).toBe(400)

          const optionsResponse = yield* Effect.promise(() =>
            auth.request(
              "https://auth.example.com/oauth/passkey/register-options",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionBearer }),
              },
            ),
          )
          expect(optionsResponse.status).toBe(200)
          const body = (yield* Effect.promise(() =>
            optionsResponse.json(),
          )) as {
            challengeId: string
            options: {
              user: { name: string; displayName: string }
              authenticatorSelection: {
                residentKey: string
                requireResidentKey: boolean
                userVerification: string
              }
            }
          }
          expect(body.challengeId).toBeTruthy()
          expect(body.options.user.name).toBe(email)
          expect(body.options.user.displayName).toBe(email)
          expect(body.options.authenticatorSelection.residentKey).toBe(
            "required",
          )
          expect(body.options.authenticatorSelection.requireResidentKey).toBe(
            true,
          )
          expect(body.options.authenticatorSelection.userVerification).toBe(
            "required",
          )
        }),
        TestLayer,
      ),
    )
  })

  it("commit path accepts Invitation, assigns roles, clears link and sessions", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "accept@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)

          const authDb = yield* AuthenticationDatabase
          const exchanged = yield* authDb.exchangeRegistrationLink(rawToken)
          expect(Option.isSome(exchanged)).toBe(true)
          if (Option.isNone(exchanged)) return

          const session = exchanged.value
          const resolved = yield* authDb.resolveInvitationRegistrationSession(
            session.sessionBearer,
          )
          expect(Option.isSome(resolved)).toBe(true)
          if (Option.isNone(resolved)) return

          const userHandle = Buffer.from(
            "invite-handle-32-bytes-!!!!!!!",
          ).toString("base64url")

          const registered = yield* registerProviderUserByPasskey({
            type: "registration",
            registrationKind: "invitation",
            email: session.email,
            userHandle,
            invitationId: session.invitationId,
            linkGeneration: session.linkGeneration,
            sessionTokenHash: resolved.value.sessionTokenHash,
            sessionBearer: session.sessionBearer,
            credential: {
              id: "cred-invite-1",
              publicKey: "AQIDBA",
              counter: 0,
              transports: ["internal"],
            },
          })

          expect(registered.email).toBe(email)
          expect(registered.roles).toContain(setup.testerRolePath)

          const db = yield* TypedSqliteDrizzle
          const [invitation] = yield* db
            .select({
              status: schema.invitation.invitationStatus,
              pending: schema.invitation.invitationPendingEmail,
              tokenHash: schema.invitation.registrationTokenHash,
              generation: schema.invitation.registrationLinkGeneration,
            })
            .from(schema.invitation)
            .where(eq(schema.invitation.id, setup.invitationId))
          expect(invitation?.status).toBe("accepted")
          expect(invitation?.pending).toBeNull()
          expect(invitation?.tokenHash).toBeNull()
          expect(invitation?.generation).toBe(2)

          const liveSessions = yield* db
            .select({ id: schema.registrationSession.id })
            .from(schema.registrationSession)
            .where(
              and(
                eq(schema.registrationSession.invitationId, setup.invitationId),
                eq(schema.registrationSession._deleted, false),
              ),
            )
          expect(liveSessions).toHaveLength(0)

          // Session no longer resolves after acceptance.
          const after = yield* authDb.resolveInvitationRegistrationSession(
            session.sessionBearer,
          )
          expect(Option.isNone(after)).toBe(true)
        }),
        TestLayer,
      ),
    )
  })

  it("rotation invalidates an already exchanged Registration Session", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "rotate@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)
          const authDb = yield* AuthenticationDatabase
          const exchanged = yield* authDb.exchangeRegistrationLink(rawToken)
          expect(Option.isSome(exchanged)).toBe(true)
          if (Option.isNone(exchanged)) return

          const db = yield* TypedSqliteDrizzle
          const now = yield* DateTime.now
          // Rotate generation without deleting the session row.
          yield* db
            .update(schema.invitation)
            .set({
              registrationTokenHash: "new-hash-after-rotate",
              registrationLinkGeneration: 2,
              updatedAt: now,
            })
            .where(eq(schema.invitation.id, setup.invitationId))

          const resolved = yield* authDb.resolveInvitationRegistrationSession(
            exchanged.value.sessionBearer,
          )
          expect(Option.isNone(resolved)).toBe(true)

          const exit = yield* Effect.exit(
            registerProviderUserByPasskey({
              type: "registration",
              registrationKind: "invitation",
              email: exchanged.value.email,
              userHandle: Buffer.from("rotate-handle-32-bytes-!!!!!!").toString(
                "base64url",
              ),
              invitationId: exchanged.value.invitationId,
              linkGeneration: exchanged.value.linkGeneration,
              sessionTokenHash: "stale",
              sessionBearer: exchanged.value.sessionBearer,
              credential: {
                id: "cred-rotate-stale",
                publicKey: "AQIDBA",
                counter: 0,
              },
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain(
              "PasskeyInvitationRegistrationDeniedError",
            )
          }

          const owner = yield* authDb.findProviderUserByEmail(email)
          expect(Option.isNone(owner)).toBe(true)
        }),
        TestLayer,
      ),
    )
  })

  it("ensures concurrent Invitation registration commits exactly one winner", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "race@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)
          const authDb = yield* AuthenticationDatabase
          const sql = yield* SqlClient.SqlClient

          const a = yield* authDb.exchangeRegistrationLink(rawToken)
          const b = yield* authDb.exchangeRegistrationLink(rawToken)
          expect(Option.isSome(a)).toBe(true)
          expect(Option.isSome(b)).toBe(true)
          if (Option.isNone(a) || Option.isNone(b)) return

          const sessionA = yield* authDb.resolveInvitationRegistrationSession(
            a.value.sessionBearer,
          )
          const sessionB = yield* authDb.resolveInvitationRegistrationSession(
            b.value.sessionBearer,
          )
          expect(Option.isSome(sessionA)).toBe(true)
          expect(Option.isSome(sessionB)).toBe(true)
          if (Option.isNone(sessionA) || Option.isNone(sessionB)) return

          const registerInTransaction = (
            sessionBearer: string,
            email: string,
            invitationId: string,
            linkGeneration: number,
            sessionTokenHash: string,
            credentialId: string,
            handle: string,
          ) =>
            sql.withTransaction(
              registerProviderUserByPasskey({
                type: "registration",
                registrationKind: "invitation",
                email,
                userHandle: Buffer.from(handle).toString("base64url"),
                invitationId,
                linkGeneration,
                sessionTokenHash,
                sessionBearer,
                credential: {
                  id: credentialId,
                  publicKey: "AQIDBA",
                  counter: 0,
                },
              }),
            )

          const results = yield* Effect.all(
            [
              Effect.exit(
                registerInTransaction(
                  a.value.sessionBearer,
                  a.value.email,
                  sessionA.value.invitationId,
                  sessionA.value.linkGeneration,
                  sessionA.value.sessionTokenHash,
                  "cred-race-a",
                  "race-handle-a-32-bytes!!!!!!!!!",
                ),
              ),
              Effect.exit(
                registerInTransaction(
                  b.value.sessionBearer,
                  b.value.email,
                  sessionB.value.invitationId,
                  sessionB.value.linkGeneration,
                  sessionB.value.sessionTokenHash,
                  "cred-race-b",
                  "race-handle-b-32-bytes!!!!!!!!!",
                ),
              ),
            ],
            { concurrency: 2 },
          )

          const successes = results.filter((r) => Exit.isSuccess(r))
          const failures = results.filter((r) => Exit.isFailure(r))
          expect(successes).toHaveLength(1)
          expect(failures).toHaveLength(1)

          if (Exit.isFailure(failures[0]!)) {
            const error = Cause.failureOption(failures[0]!.cause)
            if (Option.isSome(error)) {
              const isTyped =
                error.value instanceof PasskeyInvitationRegistrationDeniedError
              if (!isTyped) {
                expect(String(error.value)).toBeTruthy()
              }
            }
          }

          const db = yield* TypedSqliteDrizzle
          const providerUsers = yield* db
            .select({ id: schema.providerUser.id })
            .from(schema.providerUser)
            .where(
              and(
                eq(schema.providerUser.email, email),
                eq(schema.providerUser._deleted, false),
              ),
            )
          expect(providerUsers).toHaveLength(1)

          const credentials = yield* db
            .select({ id: schema.passkeyCredential.id })
            .from(schema.passkeyCredential)
            .where(eq(schema.passkeyCredential._deleted, false))
          expect(credentials).toHaveLength(1)

          const [invitation] = yield* db
            .select({ status: schema.invitation.invitationStatus })
            .from(schema.invitation)
            .where(eq(schema.invitation.id, setup.invitationId))
          expect(invitation?.status).toBe("accepted")
        }),
        TestLayer,
      ),
    )
  })

  it("leaves Invitation retryable after exchange without commit", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "retryable@example.com"
          const setup = yield* setupTestData(email)
          yield* insertPasskeyProvider()
          const rawToken = yield* storeLiveLink(setup.invitationId)
          const authDb = yield* AuthenticationDatabase

          const first = yield* authDb.exchangeRegistrationLink(rawToken)
          expect(Option.isSome(first)).toBe(true)

          // Exchange alone does not consume the link.
          const second = yield* authDb.exchangeRegistrationLink(rawToken)
          expect(Option.isSome(second)).toBe(true)

          const db = yield* TypedSqliteDrizzle
          const [invitation] = yield* db
            .select({
              status: schema.invitation.invitationStatus,
              tokenHash: schema.invitation.registrationTokenHash,
            })
            .from(schema.invitation)
            .where(eq(schema.invitation.id, setup.invitationId))
          expect(invitation?.status).toBe("pending")
          expect(invitation?.tokenHash).toBeTruthy()
        }),
        TestLayer,
      ),
    )
  })
})
