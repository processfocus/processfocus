import { SqlClient } from "@effect/sql"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, type Layer, Option } from "effect"
import {
  AuthenticationDatabase,
  type CreateProviderUserInput,
  createAuthenticationServer,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const createRootOrgUnit = () =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const [rootOrgUnit] = yield* db
      .insert(schema.orgUnit)
      .values({
        name: "Root Organization",
        orgUnitLevel: "root",
        path: "/",
        parentOrgUnitId: null,
      })
      .returning()

    if (!rootOrgUnit) throw new Error("Failed to create root org unit")
    return rootOrgUnit.id
  })

const createProviderUser = (
  orgUnitId: string,
  overrides: Partial<CreateProviderUserInput> = {},
) =>
  Effect.gen(function* () {
    const authDb = yield* AuthenticationDatabase
    return yield* authDb.createProviderUser({
      email: "passkey@example.com",
      name: "Passkey User",
      firstName: "Passkey",
      lastName: "User",
      picture: "",
      locale: "en",
      provider: "passkey",
      sub: "opaque-user-handle",
      orgUnitId,
      ...overrides,
    })
  })

type TestRequirements = Layer.Layer.Success<typeof TestLayer>

const runTest = <A, E>(
  test: Effect.Effect<A, E, TestRequirements>,
): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

describe("SQLite passkey authentication database", () => {
  it("creates and looks up a relational credential linked by an opaque user handle", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const userHandle = Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("base64url")
        const providerUser = yield* createProviderUser(orgUnitId, {
          email: "random-handle@example.com",
          sub: userHandle,
        })

        expect(userHandle).not.toContain("random-handle@example.com")

        yield* authDb.createPasskeyCredential({
          userId: providerUser.id,
          credentialId: "credential-relational",
          publicKey: "public-key-relational",
          counter: 3,
          transports: ["internal", "hybrid"],
        })

        const found = yield* authDb.findPasskeyCredentialById(
          "credential-relational",
        )
        expect(Option.getOrUndefined(found)).toEqual({
          userId: providerUser.id,
          email: "random-handle@example.com",
          provider: "passkey",
          sub: userHandle,
          credentialId: "credential-relational",
          publicKey: "public-key-relational",
          counter: 3,
          transports: ["internal", "hybrid"],
        })
      }),
    ))

  it("applies compare-and-set semantics to zero and non-zero counters", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const providerUser = yield* createProviderUser(orgUnitId)

        yield* authDb.createPasskeyCredential({
          userId: providerUser.id,
          credentialId: "credential-counter",
          publicKey: "public-key-counter",
          counter: 0,
        })

        expect(
          yield* authDb.advancePasskeyCredentialCounter(
            "credential-counter",
            0,
            0,
          ),
        ).toBe(true)
        expect(
          yield* authDb.advancePasskeyCredentialCounter(
            "credential-counter",
            0,
            7,
          ),
        ).toBe(true)
        expect(
          yield* authDb.advancePasskeyCredentialCounter(
            "credential-counter",
            0,
            9,
          ),
        ).toBe(false)
        expect(
          yield* authDb.advancePasskeyCredentialCounter(
            "credential-counter",
            7,
            8,
          ),
        ).toBe(true)

        const found =
          yield* authDb.findPasskeyCredentialById("credential-counter")
        expect(Option.getOrUndefined(found)?.counter).toBe(8)
      }),
    ))

  it("rejects a credential ID already owned by another user", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId, {
          email: "credential-owner@example.com",
          sub: "credential-owner-handle",
        })
        const contender = yield* createProviderUser(orgUnitId, {
          email: "credential-contender@example.com",
          sub: "credential-contender-handle",
        })

        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-collision",
          publicKey: "owner-public-key",
          counter: 0,
        })
        const collision = yield* Effect.either(
          authDb.createPasskeyCredential({
            userId: contender.id,
            credentialId: "credential-collision",
            publicKey: "contender-public-key",
            counter: 0,
          }),
        )

        expect(collision._tag).toBe("Left")
        const found = yield* authDb.findPasskeyCredentialById(
          "credential-collision",
        )
        expect(Option.getOrUndefined(found)?.userId).toBe(owner.id)
        expect(Option.getOrUndefined(found)?.publicKey).toBe("owner-public-key")
      }),
    ))

  it("rolls back User and Provider User when credential creation fails", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const authDb = yield* AuthenticationDatabase
        const sqlClient = yield* SqlClient.SqlClient
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId, {
          email: "rollback-owner@example.com",
          sub: "rollback-owner-handle",
        })

        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "rollback-collision",
          publicKey: "rollback-owner-key",
          counter: 0,
        })

        const result = yield* Effect.either(
          sqlClient.withTransaction(
            Effect.gen(function* () {
              const providerUser = yield* createProviderUser(orgUnitId, {
                email: "rolled-back@example.com",
                sub: "rolled-back-handle",
              })
              yield* authDb.createPasskeyCredential({
                userId: providerUser.id,
                credentialId: "rollback-collision",
                publicKey: "rolled-back-key",
                counter: 0,
              })
            }),
          ),
        )

        expect(result._tag).toBe("Left")
        const rolledBackUsers = yield* db
          .select()
          .from(schema.user)
          .where(
            and(
              eq(schema.user.provider, "passkey"),
              eq(schema.user.sub, "rolled-back-handle"),
            ),
          )
        const rolledBackProviderUsers = yield* db
          .select()
          .from(schema.providerUser)
          .where(eq(schema.providerUser.email, "rolled-back@example.com"))
        const credentials = yield* db
          .select()
          .from(schema.passkeyCredential)
          .where(
            eq(
              schema.passkeyCredential.passkeyCredentialId,
              "rollback-collision",
            ),
          )

        expect(rolledBackUsers).toHaveLength(0)
        expect(rolledBackProviderUsers).toHaveLength(0)
        expect(credentials).toHaveLength(1)
        expect(credentials[0]?.userId).toBe(owner.id)
      }),
    ))

  it("lists unnamed credentials and renames without uniqueness", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId)
        const other = yield* createProviderUser(orgUnitId, {
          email: "other-passkey@example.com",
          sub: "other-handle",
        })

        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-unnamed",
          publicKey: "public-key-unnamed",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-named",
          publicKey: "public-key-named",
          counter: 0,
          name: "Spare key",
        })
        yield* authDb.createPasskeyCredential({
          userId: other.id,
          credentialId: "credential-other",
          publicKey: "public-key-other",
          counter: 0,
          name: "Other key",
        })

        const listed = yield* authDb.listPasskeyCredentialsForUser(owner.id)
        const unnamed = listed.find((item) => item.name === null)
        expect(listed).toHaveLength(2)
        expect(unnamed).toBeDefined()
        expect(listed.every((item) => item.lastUsedAt === null)).toBe(true)
        expect(listed.some((item) => item.name === "Spare key")).toBe(true)
        expect(
          yield* authDb.renamePasskeyCredential({
            userId: owner.id,
            id: unnamed?.id ?? "",
            name: "Spare key",
          }),
        ).toBe(true)
        expect(
          new Set(
            (yield* authDb.listPasskeyCredentialsForUser(owner.id)).map(
              (item) => item.name,
            ),
          ),
        ).toEqual(new Set(["Spare key"]))
        expect(
          yield* authDb.renamePasskeyCredential({
            userId: other.id,
            id: unnamed?.id ?? "",
            name: "Stolen",
          }),
        ).toBe(false)
        expect(
          (yield* authDb.listPasskeyCredentialsForUser(other.id)).map(
            (item) => item.name,
          ),
        ).toEqual(["Other key"])
      }),
    ))

  it("records last-used independently of rename and account last login", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId)

        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-used",
          publicKey: "public-key-used",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-idle",
          publicKey: "public-key-idle",
          counter: 7,
        })

        yield* authDb.updateLastLoggedIn(
          owner.id,
          DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
        )
        expect(
          (yield* authDb.listPasskeyCredentialsForUser(owner.id)).every(
            (item) => item.lastUsedAt === null,
          ),
        ).toBe(true)

        const usedAt = DateTime.unsafeMake("2026-04-05T06:07:00.000Z")
        expect(
          yield* authDb.advancePasskeyCredentialCounter(
            "credential-used",
            0,
            0,
            usedAt,
          ),
        ).toBe(true)

        const db = yield* TypedSqliteDrizzle
        const rows = yield* db
          .select({
            id: schema.passkeyCredential.id,
            credentialId: schema.passkeyCredential.passkeyCredentialId,
          })
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, owner.id))
        const usedId = rows.find(
          (row) => row.credentialId === "credential-used",
        )?.id
        const idleId = rows.find(
          (row) => row.credentialId === "credential-idle",
        )?.id
        const listed = yield* authDb.listPasskeyCredentialsForUser(owner.id)
        const used = listed.find((item) => item.id === usedId)
        const idle = listed.find((item) => item.id === idleId)
        expect(used?.lastUsedAt).toEqual(usedAt)
        expect(idle?.lastUsedAt).toBeNull()

        expect(
          yield* authDb.renamePasskeyCredential({
            userId: owner.id,
            id: usedId ?? "",
            name: "Laptop key",
          }),
        ).toBe(true)
        const afterRename = yield* authDb.listPasskeyCredentialsForUser(
          owner.id,
        )
        expect(
          afterRename.find((item) => item.id === usedId)?.lastUsedAt,
        ).toEqual(usedAt)
        expect(
          afterRename.find((item) => item.id === idleId)?.lastUsedAt,
        ).toBeNull()
      }),
    ))

  it("removes one of two credentials atomically and rejects the last", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId)
        const other = yield* createProviderUser(orgUnitId, {
          email: "other-remove@example.com",
          sub: "other-remove-handle",
        })

        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-keep",
          publicKey: "public-key-keep",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-drop",
          publicKey: "public-key-drop",
          counter: 0,
          name: "Spare key",
        })
        yield* authDb.createPasskeyCredential({
          userId: other.id,
          credentialId: "credential-other-remove",
          publicKey: "public-key-other",
          counter: 0,
        })

        const listed = yield* authDb.listPasskeyCredentialsForUser(owner.id)
        const spare = listed.find((item) => item.name === "Spare key")
        expect(spare).toBeDefined()
        expect(
          yield* authDb.removePasskeyCredential({
            userId: owner.id,
            id: spare?.id ?? "",
          }),
        ).toBe("removed")
        expect(
          yield* authDb.listPasskeyCredentialsForUser(owner.id),
        ).toHaveLength(1)
        expect(
          Option.isNone(
            yield* authDb.findPasskeyCredentialById("credential-drop"),
          ),
        ).toBe(true)
        expect(
          Option.isSome(
            yield* authDb.findPasskeyCredentialById("credential-keep"),
          ),
        ).toBe(true)

        const remaining = (yield* authDb.listPasskeyCredentialsForUser(
          owner.id,
        ))[0]
        expect(
          yield* authDb.removePasskeyCredential({
            userId: owner.id,
            id: remaining?.id ?? "",
          }),
        ).toBe("last_credential")
        expect(
          Option.isSome(
            yield* authDb.findPasskeyCredentialById("credential-keep"),
          ),
        ).toBe(true)

        const otherCredential = (yield* authDb.listPasskeyCredentialsForUser(
          other.id,
        ))[0]
        expect(
          yield* authDb.removePasskeyCredential({
            userId: owner.id,
            id: otherCredential?.id ?? "",
          }),
        ).toBe("not_found")
        expect(
          Option.isSome(
            yield* authDb.findPasskeyCredentialById("credential-other-remove"),
          ),
        ).toBe(true)

        const stored = yield* db
          .select()
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, owner.id))
        expect(stored.filter((row) => row._deleted)).toHaveLength(1)
      }),
    ))

  it("leaves at least one credential when two removals race", () =>
    runTest(
      Effect.gen(function* () {
        const authDb = yield* AuthenticationDatabase
        const orgUnitId = yield* createRootOrgUnit()
        const owner = yield* createProviderUser(orgUnitId, {
          email: "race-owner@example.com",
          sub: "race-owner-handle",
        })
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "race-one",
          publicKey: "public-key-race-one",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "race-two",
          publicKey: "public-key-race-two",
          counter: 0,
        })
        const listed = yield* authDb.listPasskeyCredentialsForUser(owner.id)
        expect(listed).toHaveLength(2)
        const outcomes = yield* Effect.all(
          [
            authDb.removePasskeyCredential({
              userId: owner.id,
              id: listed[0]?.id ?? "",
            }),
            authDb.removePasskeyCredential({
              userId: owner.id,
              id: listed[1]?.id ?? "",
            }),
          ],
          { concurrency: "unbounded" },
        )
        expect(new Set(outcomes)).toEqual(
          new Set(["removed", "last_credential"]),
        )
        expect(
          yield* authDb.listPasskeyCredentialsForUser(owner.id),
        ).toHaveLength(1)
      }),
    ))

  it("rejects registration options for an email owned by an OAuth Provider User", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const orgUnitId = yield* createRootOrgUnit()
        yield* createProviderUser(orgUnitId, {
          email: "OAuth-Owner@Example.com",
          provider: "google",
          sub: "google-oauth-owner",
        })
        yield* db.insert(schema.oauthProvider).values({
          providerName: "passkey",
          providerConfig: {
            rpName: "Test App",
            rpID: "example.com",
            origin: "https://example.com",
            inviteOnly: false,
          },
        })

        const { app, runtime } = yield* createAuthenticationServer({
          clients: [
            {
              id: "test-client",
              redirectUris: ["https://test.example.com/callback"],
            },
          ],
        })
        const auth = createTestApp(app, { runtime })
        const response = yield* Effect.promise(() =>
          auth.request(
            "https://auth.example.com/oauth/passkey/register-options",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: "  OAUTH-OWNER@EXAMPLE.COM  " }),
            },
          ),
        )

        expect(response.status).toBe(403)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: "Registration is not available for this email",
        })
      }),
    ))
})
