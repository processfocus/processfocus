import { generateKeyPairSync } from "node:crypto"
import { eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, type Layer, Option } from "effect"
import {
  AuthenticationDatabase,
  type CreateProviderUserInput,
  DummyProviderUserNotFoundError,
  InviteRequiredError,
  ProviderUserEmailAlreadyOwnedError,
  RootOrgUnitNotFoundError,
  VerifiedEmailRequiredError,
  findDummyProviderUser,
  findExistingProviderUserBySubject,
  findOrCreateProviderUserFromVerifiedIdentity,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import type {
  NormalizedEmail,
  VerifiedHumanIdentity,
} from "@pf/openauth/provider/provider"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteAuthenticationDatabaseLive } from "../src/lib/authentication-database.js"
import { describe, expect, it } from "bun:test"

const mockVerifiedIdentity: VerifiedHumanIdentity = {
  type: "verified-human-identity",
  provider: "google",
  subject: "google-id-12345",
  email: "test@example.com" as NormalizedEmail,
  profile: {
    name: "Test User",
    givenName: "Test",
    familyName: "User",
    picture: "https://example.com/photo.jpg",
    locale: "en",
  },
  emailVerification: {
    method: "oidc-claim",
    claim: "email_verified",
    verified: true,
  },
}

const mockDummyToken = {
  sub: "dummy-sub-different",
  email: "test@example.com",
  name: "Test User",
  given_name: "Test",
  family_name: "User",
  picture: "https://example.com/photo.jpg",
  email_verified: true,
  locale: "en",
}

type TestRequirements =
  | AuthenticationDatabase
  | Layer.Layer.Success<typeof DatabaseTest>

const runTest = <A, E>(
  test: Effect.Effect<A, E, TestRequirements>,
): Promise<A> => {
  return Effect.runPromise(
    Effect.provide(
      Effect.provide(test, SqliteAuthenticationDatabaseLive),
      DatabaseTest,
    ),
  )
}

describe("provider-user-auth", () => {
  // Helper to create root org unit for tests
  const createRootOrgUnit = () =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle

      const results = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Root Organization",
          orgUnitLevel: "root",
          path: "/",
          parentOrgUnitId: null,
        })
        .returning()

      if (!results[0]) {
        throw new Error("Failed to create org unit")
      }

      return results[0].id
    })

  const insertOAuthProvider = (
    providerName: string,
    providerConfig: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* db.insert(schema.oauthProvider).values({
        providerName,
        providerConfig,
      })
    })

  it("should keep existing provider users when inviteOnly is true", async () => {
    await runTest(
      Effect.gen(function* () {
        const rootOrgUnitId = yield* createRootOrgUnit()
        const authDb = yield* AuthenticationDatabase
        yield* insertOAuthProvider("google", {
          clientID: "test-google-client-id",
          clientSecret: "test-google-client-secret",
          scopes: ["openid", "email", "profile"],
          inviteOnly: true,
        })

        // First, create a provider user with the provider and subject ID
        const providerUserData: CreateProviderUserInput = {
          email: "existing@example.com",
          name: "Existing User",
          firstName: "Existing",
          lastName: "User",
          picture: "",
          locale: "en",
          provider: "google",
          sub: mockVerifiedIdentity.subject,
          orgUnitId: rootOrgUnitId,
        }

        const createdProviderUser =
          yield* authDb.createProviderUser(providerUserData)

        // Subject continuity without verified email still signs existing users in
        const foundProviderUser = yield* findExistingProviderUserBySubject({
          type: "provider-subject-identity",
          provider: "google",
          subject: mockVerifiedIdentity.subject,
        })

        if (!foundProviderUser) {
          throw new Error("Expected to find provider user")
        }

        expect(foundProviderUser.id).toBe(createdProviderUser.id)
        expect(foundProviderUser.provider).toBe("google")
        expect(foundProviderUser.sub).toBe(mockVerifiedIdentity.subject)
        expect(foundProviderUser.email).toBe("existing@example.com") // Should keep existing email
      }),
    )
  })

  it("should create new provider user from verified identity", async () => {
    await runTest(
      Effect.gen(function* () {
        const rootOrgUnitId = yield* createRootOrgUnit()
        yield* insertOAuthProvider("google", {
          clientID: "test-google-client-id",
          clientSecret: "test-google-client-secret",
          scopes: ["openid", "email", "profile"],
          inviteOnly: false,
        })

        const newProviderUser =
          yield* findOrCreateProviderUserFromVerifiedIdentity(
            mockVerifiedIdentity,
          )

        if (!newProviderUser) {
          throw new Error("Expected to create provider user")
        }

        expect(newProviderUser.provider).toBe("google")
        expect(newProviderUser.sub).toBe(mockVerifiedIdentity.subject)
        expect(newProviderUser.email).toBe(mockVerifiedIdentity.email)
        expect(newProviderUser.locale).toBe(
          mockVerifiedIdentity.profile.locale ?? "",
        )
        expect(newProviderUser.orgUnitId).toBe(rootOrgUnitId)
      }),
    )
  })

  it("should reject verified-identity create when email is already owned", async () => {
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            const rootOrgUnitId = yield* createRootOrgUnit()
            const authDb = yield* AuthenticationDatabase
            yield* insertOAuthProvider("github", {
              clientID: "test-github-client-id",
              clientSecret: "test-github-client-secret",
              scopes: ["read:user", "user:email"],
              inviteOnly: false,
            })

            // Existing Provider User under a different provider/subject owns the email.
            yield* authDb.createProviderUser({
              email: mockVerifiedIdentity.email,
              name: "Existing Owner",
              firstName: "Existing",
              lastName: "Owner",
              picture: "",
              locale: "en",
              provider: "google",
              sub: "other-google-subject",
              orgUnitId: rootOrgUnitId,
            })

            return yield* findOrCreateProviderUserFromVerifiedIdentity({
              ...mockVerifiedIdentity,
              provider: "github",
              subject: "github-new-subject",
            })
          }),
          SqliteAuthenticationDatabaseLive,
        ),
        DatabaseTest,
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.failureOption(result.cause)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(ProviderUserEmailAlreadyOwnedError)
      }
    }
  })

  it("should reject subject-only identity for first-user creation", async () => {
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            yield* createRootOrgUnit()
            return yield* findExistingProviderUserBySubject({
              type: "provider-subject-identity",
              provider: "google",
              subject: "unknown-subject",
            })
          }),
          SqliteAuthenticationDatabaseLive,
        ),
        DatabaseTest,
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.failureOption(result.cause)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(VerifiedEmailRequiredError)
      }
    }
  })

  it("should handle root org unit not found", async () => {
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            yield* insertOAuthProvider("google", {
              clientID: "test-google-client-id",
              clientSecret: "test-google-client-secret",
              scopes: ["openid", "email", "profile"],
              inviteOnly: false,
            })
            return yield* findOrCreateProviderUserFromVerifiedIdentity(
              mockVerifiedIdentity,
            )
          }),
          SqliteAuthenticationDatabaseLive,
        ),
        DatabaseTest,
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe("Fail")
      if (result.cause._tag === "Fail") {
        expect(result.cause.error).toBeInstanceOf(RootOrgUnitNotFoundError)
      }
    }
  })

  it("should let dummy provider reuse an existing provider user by email", async () => {
    await runTest(
      Effect.gen(function* () {
        const rootOrgUnitId = yield* createRootOrgUnit()
        const authDb = yield* AuthenticationDatabase

        // Create a provider user with google provider
        const providerUserData: CreateProviderUserInput = {
          email: mockVerifiedIdentity.email,
          name: "Google User",
          firstName: "Google",
          lastName: "User",
          picture: "",
          locale: "en",
          provider: "google",
          sub: "original-google-sub",
          orgUnitId: rootOrgUnitId,
        }

        const createdProviderUser =
          yield* authDb.createProviderUser(providerUserData)

        const foundProviderUser = yield* findDummyProviderUser(mockDummyToken)

        if (!foundProviderUser) {
          throw new Error("Expected to find provider user")
        }

        // Should find the existing provider user by email
        expect(foundProviderUser.id).toBe(createdProviderUser.id)
        // Provider/sub should remain as originally created (google)
        expect(foundProviderUser.provider).toBe("google")
        expect(foundProviderUser.sub).toBe("original-google-sub")
        expect(foundProviderUser.email).toBe(mockVerifiedIdentity.email)
      }),
    )
  })

  it("should reject dummy provider when no existing provider user matches email", async () => {
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.provide(
          findDummyProviderUser(mockDummyToken),
          SqliteAuthenticationDatabaseLive,
        ),
        DatabaseTest,
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe("Fail")
      if (result.cause._tag === "Fail") {
        expect(result.cause.error).toBeInstanceOf(
          DummyProviderUserNotFoundError,
        )
      }
    }
  })

  it("should require invitation by default for new Google users", async () => {
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            yield* createRootOrgUnit()
            yield* insertOAuthProvider("google", {
              clientID: "test-google-client-id",
              clientSecret: "test-google-client-secret",
              scopes: ["openid", "email", "profile"],
            })
            return yield* findOrCreateProviderUserFromVerifiedIdentity(
              mockVerifiedIdentity,
            )
          }),
          SqliteAuthenticationDatabaseLive,
        ),
        DatabaseTest,
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.failureOption(result.cause)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(InviteRequiredError)
      }
    }
  })

  it("should allow invited Google users when inviteOnly is true", async () => {
    await runTest(
      Effect.gen(function* () {
        const rootOrgUnitId = yield* createRootOrgUnit()
        yield* insertOAuthProvider("google", {
          clientID: "test-google-client-id",
          clientSecret: "test-google-client-secret",
          scopes: ["openid", "email", "profile"],
        })

        const db = yield* TypedSqliteDrizzle
        const [role] = yield* db
          .insert(schema.role)
          .values({
            name: "Employee",
            orgUnitId: rootOrgUnitId,
            path: "/Employee",
          })
          .returning()

        if (!role) throw new Error("Failed to create role")

        const [invitation] = yield* db
          .insert(schema.invitation)
          .values({
            invitationId: "test-google-invite",
            email: mockVerifiedIdentity.email.toLowerCase(),
            invitationStatus: "pending",
            invitationSource: "dashboard",
            invitationPendingEmail: mockVerifiedIdentity.email.toLowerCase(),
          })
          .returning()

        if (!invitation) throw new Error("Failed to create invitation")

        yield* db.insert(schema.invitationRole).values({
          invitationId: invitation.id,
          roleId: role.id,
        })

        const providerUser =
          yield* findOrCreateProviderUserFromVerifiedIdentity(
            mockVerifiedIdentity,
          )
        expect(providerUser.roles).toEqual(["/Employee"])

        const [acceptedInvitation] = yield* db
          .select({
            status: schema.invitation.invitationStatus,
            pendingEmail: schema.invitation.invitationPendingEmail,
            acceptedByProvider: schema.invitation.invitationAcceptedByProvider,
            acceptedBySubject: schema.invitation.invitationAcceptedBySubject,
            acceptedByProviderUserId:
              schema.invitation.acceptedByProviderUserId,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitation.id))
          .limit(1)

        expect(acceptedInvitation?.status).toBe("accepted")
        expect(acceptedInvitation?.pendingEmail).toBeNull()
        expect(acceptedInvitation?.acceptedByProvider).toBe("google")
        expect(acceptedInvitation?.acceptedBySubject).toBe(
          mockVerifiedIdentity.subject,
        )
        expect(acceptedInvitation?.acceptedByProviderUserId).toBeTruthy()
      }),
    )
  })

  it("should leave invitation pending when provider user creation fails after role lookup", async () => {
    await runTest(
      Effect.gen(function* () {
        const rootOrgUnitId = yield* createRootOrgUnit()
        yield* insertOAuthProvider("google", {
          clientID: "test-google-client-id",
          clientSecret: "test-google-client-secret",
          scopes: ["openid", "email", "profile"],
        })

        const db = yield* TypedSqliteDrizzle
        const [role] = yield* db
          .insert(schema.role)
          .values({
            name: "Employee",
            orgUnitId: rootOrgUnitId,
            path: "/Employee",
          })
          .returning()
        if (!role) throw new Error("Failed to create role")

        // Pre-create a different provider subject that already owns the email so
        // first-login fails closed before create, leaving invitation pending.
        const existing = yield* db
          .insert(schema.user)
          .values({
            provider: "github",
            sub: "github-existing",
            lastLoggedIn: DateTime.unsafeMake(Date.now()),
          })
          .returning()
        const existingUser = existing[0]
        if (!existingUser) throw new Error("Failed to create existing user")
        yield* db.insert(schema.providerUser).values({
          userId: existingUser.id,
          email: mockVerifiedIdentity.email.toLowerCase(),
          name: "Existing",
          firstName: "Existing",
          lastName: "User",
          picture: "",
          locale: "en",
          orgUnitId: rootOrgUnitId,
        })

        const [invitation] = yield* db
          .insert(schema.invitation)
          .values({
            invitationId: "test-google-invite-owned",
            email: mockVerifiedIdentity.email.toLowerCase(),
            invitationStatus: "pending",
            invitationSource: "dashboard",
            invitationPendingEmail: mockVerifiedIdentity.email.toLowerCase(),
          })
          .returning()
        if (!invitation) throw new Error("Failed to create invitation")

        yield* db.insert(schema.invitationRole).values({
          invitationId: invitation.id,
          roleId: role.id,
        })

        const result = yield* Effect.exit(
          findOrCreateProviderUserFromVerifiedIdentity(mockVerifiedIdentity),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.failureOption(result.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(
              ProviderUserEmailAlreadyOwnedError,
            )
          }
        }

        const [stillPending] = yield* db
          .select({
            status: schema.invitation.invitationStatus,
            pendingEmail: schema.invitation.invitationPendingEmail,
          })
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitation.id))
          .limit(1)
        expect(stillPending?.status).toBe("pending")
        expect(stillPending?.pendingEmail).toBe(
          mockVerifiedIdentity.email.toLowerCase(),
        )
      }),
    )
  })

  it("should treat matching Google invitedOrgUnits as invites", async () => {
    const originalFetch = globalThis.fetch

    try {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
      const serviceAccountKey = Buffer.from(
        JSON.stringify({
          client_email: "service-account@example.com",
          private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        }),
      ).toString("base64")

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url

        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "google-token" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          )
        }

        if (
          url.includes("https://admin.googleapis.com/admin/directory/v1/users/")
        ) {
          return new Response(JSON.stringify({ orgUnitPath: "/Teachers" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }

        throw new Error(`Unexpected fetch request: ${url}`)
      }) as typeof fetch

      await runTest(
        Effect.gen(function* () {
          const rootOrgUnitId = yield* createRootOrgUnit()
          yield* insertOAuthProvider("google", {
            clientID: "test-google-client-id",
            clientSecret: "test-google-client-secret",
            scopes: ["openid", "email", "profile"],
            invitedOrgUnits: ["/Teachers"],
            orgUnitAsRole: true,
            serviceAccountKey,
            adminEmail: "admin@example.com",
          })

          const db = yield* TypedSqliteDrizzle
          const [teacherRole] = yield* db
            .insert(schema.role)
            .values({
              name: "Teachers",
              orgUnitId: rootOrgUnitId,
              path: "/Teachers",
            })
            .returning()

          if (!teacherRole) throw new Error("Failed to create teacher role")

          const providerUser =
            yield* findOrCreateProviderUserFromVerifiedIdentity(
              mockVerifiedIdentity,
            )
          expect(providerUser.roles).toEqual(["/Teachers"])
        }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
