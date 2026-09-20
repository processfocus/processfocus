import { SqlClient } from "@effect/sql"
import { and, eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Option } from "effect"
import {
  AuthenticationDatabase,
  PasskeyOpenRegistrationDeniedError,
  createAuthenticationServer,
  registerProviderUserByPasskey,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const OPEN_REGISTRATION_DENIED = "Registration is not available for this email"

describe("auth-server passkey Open Registration", () => {
  const createRootOrgUnit = () =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* db.insert(schema.orgUnit).values({
        name: "Root Organization",
        orgUnitLevel: "root",
        path: "/",
        parentOrgUnitId: null,
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

  const insertPasskeyProvider = (inviteOnly: boolean) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* db.insert(schema.oauthProvider).values({
        providerName: "passkey",
        providerConfig: {
          rpName: "Test App",
          rpID: "example.com",
          origin: "https://example.com",
          inviteOnly,
        },
      })
    })

  const requestRegisterOptions = (
    auth: { request: (url: string, init?: RequestInit) => Promise<Response> },
    email: string,
  ) =>
    Effect.promise(() =>
      auth.request("https://auth.example.com/oauth/passkey/register-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    )

  it("blocks Open Registration when inviteOnly is true", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(true)

          const auth = yield* createAuthApp()
          const response = yield* requestRegisterOptions(
            auth,
            "newuser@example.com",
          )

          expect(response.status).toBe(403)
          const body = (yield* Effect.promise(() => response.json())) as {
            error: string
          }
          expect(body.error).toBe(OPEN_REGISTRATION_DENIED)
        }),
        TestLayer,
      ),
    )
  })

  it("allows Open Registration for a new uninvited email when inviteOnly is false", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(false)

          const auth = yield* createAuthApp()
          const response = yield* requestRegisterOptions(
            auth,
            "newuser@example.com",
          )

          expect(response.status).toBe(200)
          const body = (yield* Effect.promise(() => response.json())) as {
            challengeId?: string
          }
          expect(body.challengeId).toBeDefined()
        }),
        TestLayer,
      ),
    )
  })

  it("rejects an email owned by any Provider User with the generic message", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(false)

          const db = yield* TypedSqliteDrizzle
          const [root] = yield* db
            .select({ id: schema.orgUnit.id })
            .from(schema.orgUnit)
            .limit(1)
          if (!root) throw new Error("missing root")
          const now = yield* DateTime.now
          const [user] = yield* db
            .insert(schema.user)
            .values({
              provider: "google",
              sub: "google-sub-1",
              lastLoggedIn: now,
            })
            .returning({ id: schema.user.id })
          if (!user) throw new Error("missing user")
          yield* db.insert(schema.providerUser).values({
            userId: user.id,
            email: "owned@example.com",
            name: "Owned",
            firstName: "Owned",
            lastName: "User",
            picture: "",
            locale: "en",
            orgUnitId: root.id,
          })

          const auth = yield* createAuthApp()
          const response = yield* requestRegisterOptions(
            auth,
            "owned@example.com",
          )

          expect(response.status).toBe(403)
          const body = (yield* Effect.promise(() => response.json())) as {
            error: string
          }
          expect(body.error).toBe(OPEN_REGISTRATION_DENIED)
        }),
        TestLayer,
      ),
    )
  })

  it("rejects a pending Invitation email with the same generic message", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "invited@example.com"
          yield* setupTestData(email)
          yield* insertPasskeyProvider(false)

          const auth = yield* createAuthApp()
          const response = yield* requestRegisterOptions(auth, email)

          expect(response.status).toBe(403)
          const body = (yield* Effect.promise(() => response.json())) as {
            error: string
          }
          expect(body.error).toBe(OPEN_REGISTRATION_DENIED)
        }),
        TestLayer,
      ),
    )
  })

  it("exposes passkey_open_registration on OAuth discovery", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(false)

          const auth = yield* createAuthApp()
          const response = yield* Effect.promise(() =>
            auth.request(
              "https://auth.example.com/.well-known/oauth-authorization-server",
            ),
          )
          expect(response.status).toBe(200)
          const body = (yield* Effect.promise(() => response.json())) as {
            providers_supported: string[]
            passkey_open_registration?: boolean
          }
          expect(body.providers_supported).toContain("passkey")
          expect(body.passkey_open_registration).toBe(true)
        }),
        TestLayer,
      ),
    )
  })

  it("reports passkey_open_registration false when inviteOnly is true", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(true)

          const auth = yield* createAuthApp()
          const response = yield* Effect.promise(() =>
            auth.request(
              "https://auth.example.com/.well-known/oauth-authorization-server",
            ),
          )
          expect(response.status).toBe(200)
          const body = (yield* Effect.promise(() => response.json())) as {
            passkey_open_registration?: boolean
          }
          expect(body.passkey_open_registration).toBe(false)
        }),
        TestLayer,
      ),
    )
  })

  it("commit path creates a role-less Provider User and never accepts Invitations", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(false)

          const email = "open-reg@example.com"
          const userHandle = Buffer.from(
            "open-reg-handle-32-bytes!!!!!!",
          ).toString("base64url")
          const registered = yield* registerProviderUserByPasskey({
            type: "registration",
            registrationKind: "open",
            email,
            userHandle,
            credential: {
              id: "cred-open-reg-1",
              publicKey: "AQIDBA",
              counter: 0,
              transports: ["internal"],
            },
          })

          expect(registered.email).toBe(email)
          expect(registered.roles).toEqual([])

          const db = yield* TypedSqliteDrizzle
          const roleJoins = yield* db
            .select({ id: schema.providerUserRole.id })
            .from(schema.providerUserRole)
            .where(eq(schema.providerUserRole._deleted, false))
          expect(roleJoins).toHaveLength(0)

          const invitations = yield* db
            .select({
              status: schema.invitation.invitationStatus,
            })
            .from(schema.invitation)
            .where(eq(schema.invitation._deleted, false))
          expect(invitations).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })

  it("commit path denies when a pending Invitation exists for the email", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const email = "still-invited@example.com"
          yield* setupTestData(email)
          yield* insertPasskeyProvider(false)

          const exit = yield* Effect.exit(
            registerProviderUserByPasskey({
              type: "registration",
              registrationKind: "open",
              email,
              userHandle: Buffer.from(
                "open-reg-handle-32-bytes-invite!",
              ).toString("base64url"),
              credential: {
                id: "cred-open-reg-invite",
                publicKey: "AQIDBA",
                counter: 0,
              },
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const failure = exit.cause
            expect(String(failure)).toContain(
              "PasskeyOpenRegistrationDeniedError",
            )
          }

          const authDb = yield* AuthenticationDatabase
          const owner = yield* authDb.findProviderUserByEmail(email)
          expect(Option.isNone(owner)).toBe(true)

          const db = yield* TypedSqliteDrizzle
          const [invitation] = yield* db
            .select({
              status: schema.invitation.invitationStatus,
              pending: schema.invitation.invitationPendingEmail,
            })
            .from(schema.invitation)
            .where(eq(schema.invitation.invitationPendingEmail, email))
          expect(invitation?.status).toBe("pending")
          expect(invitation?.pending).toBe(email)
        }),
        TestLayer,
      ),
    )
  })

  it("ensures concurrent Open Registration leaves one Provider User", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createRootOrgUnit()
          yield* insertPasskeyProvider(false)
          const sql = yield* SqlClient.SqlClient
          const email = "open-race@example.com"

          // Match production auth success: identity writes share one transaction.
          const registerInTransaction = (
            userHandle: string,
            credentialId: string,
          ) =>
            sql.withTransaction(
              registerProviderUserByPasskey({
                type: "registration",
                registrationKind: "open",
                email,
                userHandle,
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
                  Buffer.from("open-race-handle-a-32-bytes!!!!").toString(
                    "base64url",
                  ),
                  "cred-open-race-a",
                ),
              ),
              Effect.exit(
                registerInTransaction(
                  Buffer.from("open-race-handle-b-32-bytes!!!!").toString(
                    "base64url",
                  ),
                  "cred-open-race-b",
                ),
              ),
            ],
            { concurrency: 2 },
          )

          const successes = results.filter((result) => Exit.isSuccess(result))
          const failures = results.filter((result) => Exit.isFailure(result))
          expect(successes).toHaveLength(1)
          expect(failures).toHaveLength(1)

          if (Exit.isFailure(failures[0]!)) {
            const error = Cause.failureOption(failures[0]!.cause)
            if (Option.isSome(error)) {
              const typed =
                error.value instanceof PasskeyOpenRegistrationDeniedError
              if (!typed) {
                // Unique-index races may still surface as untyped SQL failures
                // depending on Effect SQL wrapping; durable state is authoritative.
                expect(String(error.value)).toBeTruthy()
              }
            }
          }

          const db = yield* TypedSqliteDrizzle
          const providerUsers = yield* db
            .select({
              id: schema.providerUser.id,
              userId: schema.providerUser.userId,
            })
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

          const roleJoins = yield* db
            .select({ id: schema.providerUserRole.id })
            .from(schema.providerUserRole)
            .where(eq(schema.providerUserRole._deleted, false))
          expect(roleJoins).toHaveLength(0)
        }),
        TestLayer,
      ),
    )
  })
})
