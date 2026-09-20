import { FetchHttpClient } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Option } from "effect"
import {
  AuthenticationDatabase,
  authenticateProviderUserByPasskey,
  createAuthenticationServer,
  exchangePasskeyRecoveryLink,
  getPasskeyUserHandle,
  hashPasskeyRecoveryBearer,
  isPasskeyRecoveryLink,
  isPasskeyRecoverySession,
  issuePasskeyRecoveryLink,
  registerProviderUserByPasskey,
  resolvePasskeyRecoverySession,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { InvitationLifecycleStatus } from "@pf/graphql-db-operations"
import { StorageService, createTestApp } from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "../src/lib/authentication-database"
import { setupTestData } from "./auth-server.fixture"
import { describe, expect, it } from "bun:test"

const TestLayer = Layer.mergeAll(
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  FetchHttpClient.layer,
).pipe(Layer.provideMerge(DatabaseTest))
const email = "recover@example.com"
const issue = () =>
  issuePasskeyRecoveryLink({
    email,
    actor: "admin@example.com",
    frontendOrigin: "https://example.com",
  })
const tokenFrom = (url: string) =>
  new URLSearchParams(new URL(url).hash.slice(1)).get("token")!

const setup = (provider = "passkey") =>
  Effect.gen(function* () {
    const fixture = yield* setupTestData(email)
    const db = yield* TypedSqliteDrizzle
    const auth = yield* AuthenticationDatabase
    yield* db.insert(schema.oauthProvider).values({
      providerName: "passkey",
      providerConfig: {
        rpName: "Test",
        rpID: "example.com",
        origin: "https://example.com",
        inviteOnly: true,
      },
    })
    const user = yield* auth.createProviderUser({
      email,
      name: "Recover",
      firstName: "",
      lastName: "",
      picture: "",
      locale: "",
      provider,
      sub: Buffer.from("existing-handle").toString("base64url"),
      orgUnitId: fixture.rootOrgUnitId,
    })
    yield* auth.assignProviderUserRoles(user.id, [fixture.testerRoleId])
    yield* auth.acceptPendingInvitationForUser({
      email,
      userId: user.id,
      provider,
      subject: user.sub,
      acceptedAt: yield* DateTime.now,
    })
    return { ...fixture, user }
  })

const register = (bearer: string, credentialId: string) =>
  Effect.gen(function* () {
    const session = yield* resolvePasskeyRecoverySession(bearer)
    expect(Option.isSome(session)).toBe(true)
    if (Option.isNone(session)) throw new Error("Expected recovery session")
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      registerProviderUserByPasskey({
        type: "registration",
        registrationKind: "recovery",
        ...session.value,
        sessionBearer: bearer,
        sessionTokenHash: hashPasskeyRecoveryBearer(bearer),
        credential: { id: credentialId, publicKey: "test-key", counter: 0 },
      }),
    )
  })

describe("passkey account recovery", () => {
  it("recovers a migrated legacy_closed account without inventing invitation acceptance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup("google")
        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.invitation)
          .set({
            invitationStatus: InvitationLifecycleStatus.LegacyClosed,
            invitationAcceptedAt: null,
            invitationAcceptedByProvider: null,
            invitationAcceptedBySubject: null,
            invitationLegacyClosedAt: yield* DateTime.now,
            invitationLegacyClosureReason: "existing_provider_user",
          })
          .where(eq(schema.invitation.id, fixture.invitationId))
        const before = yield* db.select().from(schema.invitation)
        const link = yield* issue()
        expect(link.ok).toBe(true)
        if (!link.ok) return
        const session = yield* exchangePasskeyRecoveryLink(
          tokenFrom(link.registrationLinkUrl),
        )
        expect(Option.isSome(session)).toBe(true)
        if (Option.isNone(session)) return
        const recovered = yield* register(
          session.value.sessionBearer,
          "legacy-recovery",
        )
        expect(recovered.id).toBe(fixture.user.id)
        expect(recovered.roles).toEqual([fixture.testerRolePath])
        expect(yield* db.select().from(schema.invitation)).toEqual(before)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("does not mistake random bootstrap tokens sharing a prefix for recovery", () => {
    expect(isPasskeyRecoveryLink(`pfr_${"a".repeat(39)}`)).toBe(false)
    expect(isPasskeyRecoverySession(`pfrs_${"a".repeat(38)}`)).toBe(false)
  })
  for (const provider of ["passkey", "google"]) {
    it(`adds a credential to the same ${provider} account once, preserving roles and invitation history`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fixture = yield* setup(provider)
          const db = yield* TypedSqliteDrizzle
          const auth = yield* AuthenticationDatabase
          const before = yield* db.select().from(schema.invitation)
          yield* auth.createPasskeyCredential({
            userId: fixture.user.id,
            credentialId: "existing",
            publicKey: "old-key",
            counter: 0,
          })
          const link = yield* issue()
          expect(link.ok).toBe(true)
          if (!link.ok) return
          const token = tokenFrom(link.registrationLinkUrl)
          const { app, runtime } = yield* createAuthenticationServer({
            clients: [
              {
                id: "test-client",
                redirectUris: ["https://example.com/callback"],
              },
            ],
          })
          const server = createTestApp(app, { runtime })
          const response = yield* Effect.promise(() =>
            server.request(
              "https://auth.example.com/oauth/passkey/registration-session-exchange",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
              },
            ),
          )
          expect(response.status).toBe(200)
          const session = yield* exchangePasskeyRecoveryLink(token)
          expect(Option.isSome(session)).toBe(true)
          if (Option.isNone(session)) return
          const recovered = yield* register(session.value.sessionBearer, "new")
          expect(recovered.id).toBe(fixture.user.id)
          expect(recovered.roles).toEqual([fixture.testerRolePath])
          expect(yield* db.select().from(schema.invitation)).toEqual(before)
          expect(yield* db.select().from(schema.providerUser)).toHaveLength(1)
          expect(
            yield* db.select().from(schema.passkeyCredential),
          ).toHaveLength(2)
          expect(
            Option.isNone(
              yield* resolvePasskeyRecoverySession(session.value.sessionBearer),
            ),
          ).toBe(true)
          expect(Option.isNone(yield* exchangePasskeyRecoveryLink(token))).toBe(
            true,
          )
          const credential = yield* auth.findPasskeyCredentialById("new")
          if (Option.isNone(credential)) throw new Error("Missing credential")
          const loggedIn = yield* authenticateProviderUserByPasskey({
            type: "authentication",
            email,
            userHandle: getPasskeyUserHandle(credential.value),
            credentialId: "new",
            previousCounter: 0,
            newCounter: 0,
          })
          expect(loggedIn.id).toBe(fixture.user.id)
          const storage = yield* StorageService
          const audits = yield* db.select().from(schema.oauthStorage)
          expect(
            audits.filter((row) => row.keyKind === "passkey-recovery-audit"),
          ).toHaveLength(2)
          expect(JSON.stringify(audits)).not.toContain(token)
          expect(
            yield* storage.get(["passkey-recovery-current", fixture.user.id]),
          ).toBeUndefined()
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  }

  it("records last-used only for the credential that successfully signed in", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const db = yield* TypedSqliteDrizzle
        const auth = yield* AuthenticationDatabase
        yield* auth.createPasskeyCredential({
          userId: fixture.user.id,
          credentialId: "existing",
          publicKey: "old-key",
          counter: 0,
        })
        const link = yield* issue()
        expect(link.ok).toBe(true)
        if (!link.ok) return
        const session = yield* exchangePasskeyRecoveryLink(
          tokenFrom(link.registrationLinkUrl),
        )
        expect(Option.isSome(session)).toBe(true)
        if (Option.isNone(session)) return
        const recovered = yield* register(session.value.sessionBearer, "new")
        expect(recovered.id).toBe(fixture.user.id)

        const lastUsedFor = (credentialId: string) =>
          Effect.gen(function* () {
            const rows = yield* db.select().from(schema.passkeyCredential)
            const listed = yield* auth.listPasskeyCredentialsForUser(
              fixture.user.id,
            )
            const row = rows.find(
              (item) => item.passkeyCredentialId === credentialId,
            )
            return (
              listed.find((item) => item.id === row?.id)?.lastUsedAt ?? null
            )
          })

        expect(yield* lastUsedFor("existing")).toBeNull()
        expect(yield* lastUsedFor("new")).toBeNull()

        const handle = getPasskeyUserHandle({
          provider: fixture.user.provider,
          sub: fixture.user.sub,
          userId: fixture.user.id,
        })
        yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email,
          userHandle: handle,
          credentialId: "existing",
          previousCounter: 0,
          newCounter: 0,
        })
        const existingUsed = yield* lastUsedFor("existing")
        expect(existingUsed).not.toBeNull()
        expect(yield* lastUsedFor("new")).toBeNull()

        yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email,
          userHandle: handle,
          credentialId: "new",
          previousCounter: 0,
          newCounter: 1,
        })
        const newUsed = yield* lastUsedFor("new")
        expect(newUsed).not.toBeNull()
        expect(yield* lastUsedFor("existing")).toEqual(existingUsed)

        const failedCounter = yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email,
          userHandle: handle,
          credentialId: "new",
          previousCounter: 1,
          newCounter: 1,
        }).pipe(Effect.either)
        expect(failedCounter._tag).toBe("Left")
        expect(yield* lastUsedFor("new")).toEqual(newUsed)

        const failedIdentity = yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email,
          userHandle: "wrong-handle",
          credentialId: "existing",
          previousCounter: 0,
          newCounter: 0,
        }).pipe(Effect.either)
        expect(failedIdentity._tag).toBe("Left")
        expect(yield* lastUsedFor("existing")).toEqual(existingUsed)

        const rows = yield* db.select().from(schema.passkeyCredential)
        const existingRow = rows.find(
          (item) => item.passkeyCredentialId === "existing",
        )
        expect(
          yield* auth.renamePasskeyCredential({
            userId: fixture.user.id,
            id: existingRow?.id ?? "",
            name: "Laptop key",
          }),
        ).toBe(true)
        expect(yield* lastUsedFor("existing")).toEqual(existingUsed)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("rotation invalidates both older links and already-exchanged sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const first = yield* issue()
        if (!first.ok) throw new Error(first.error)
        const token = tokenFrom(first.registrationLinkUrl)
        const session = yield* exchangePasskeyRecoveryLink(token)
        if (Option.isNone(session)) throw new Error("Missing session")
        const second = yield* issue()
        expect(second.ok).toBe(true)
        expect(Option.isNone(yield* exchangePasskeyRecoveryLink(token))).toBe(
          true,
        )
        expect(
          Option.isNone(
            yield* resolvePasskeyRecoverySession(session.value.sessionBearer),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("rolls back consumption when credential insertion fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup()
        const auth = yield* AuthenticationDatabase
        yield* auth.createPasskeyCredential({
          userId: fixture.user.id,
          credentialId: "duplicate",
          publicKey: "old-key",
          counter: 0,
        })
        const link = yield* issue()
        if (!link.ok) throw new Error(link.error)
        const session = yield* exchangePasskeyRecoveryLink(
          tokenFrom(link.registrationLinkUrl),
        )
        if (Option.isNone(session)) throw new Error("Missing session")
        const result = yield* register(
          session.value.sessionBearer,
          "duplicate",
        ).pipe(Effect.either)
        expect(result._tag).toBe("Left")
        expect(
          Option.isSome(
            yield* resolvePasskeyRecoverySession(session.value.sessionBearer),
          ),
        ).toBe(true)
        expect((yield* register(session.value.sessionBearer, "retry")).id).toBe(
          fixture.user.id,
        )
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("expires recovery links and sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const link = yield* issue()
        if (!link.ok) throw new Error(link.error)
        const token = tokenFrom(link.registrationLinkUrl)
        const session = yield* exchangePasskeyRecoveryLink(token)
        if (Option.isNone(session)) throw new Error("Missing session")
        const db = yield* TypedSqliteDrizzle
        const expired = DateTime.add(yield* DateTime.now, { hours: -1 })
        yield* db
          .update(schema.oauthStorage)
          .set({ keyExpiry: expired })
          .where(eq(schema.oauthStorage.keyKind, "passkey-recovery-session"))
        expect(
          Option.isNone(
            yield* resolvePasskeyRecoverySession(session.value.sessionBearer),
          ),
        ).toBe(true)
        yield* db
          .update(schema.oauthStorage)
          .set({ keyExpiry: expired })
          .where(eq(schema.oauthStorage.keyKind, "passkey-recovery-link"))
        expect(Option.isNone(yield* exchangePasskeyRecoveryLink(token))).toBe(
          true,
        )
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  for (const invalidation of ["user", "invitation", "roles", "provider"]) {
    it(`rejects issuance and existing sessions after ${invalidation} is disabled`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fixture = yield* setup()
          const link = yield* issue()
          if (!link.ok) throw new Error(link.error)
          const token = tokenFrom(link.registrationLinkUrl)
          const session = yield* exchangePasskeyRecoveryLink(token)
          if (Option.isNone(session)) throw new Error("Missing session")
          const db = yield* TypedSqliteDrizzle
          if (invalidation === "user")
            yield* db
              .update(schema.user)
              .set({ _deleted: true })
              .where(eq(schema.user.id, fixture.user.id))
          if (invalidation === "invitation")
            yield* db.update(schema.invitation).set({ _deleted: true })
          if (invalidation === "roles")
            yield* db.update(schema.providerUserRole).set({ _deleted: true })
          if (invalidation === "provider")
            yield* db.update(schema.oauthProvider).set({ _deleted: true })
          expect((yield* issue()).ok).toBe(false)
          expect(Option.isNone(yield* exchangePasskeyRecoveryLink(token))).toBe(
            true,
          )
          expect(
            Option.isNone(
              yield* resolvePasskeyRecoverySession(session.value.sessionBearer),
            ),
          ).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  }
})
