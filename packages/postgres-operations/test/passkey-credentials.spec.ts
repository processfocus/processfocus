import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Either, Layer, Option } from "effect"
import { AuthenticationDatabase } from "@pf/auth-api"
import * as schema from "@pf/drizzle-postgres"
import { PostgresAuthenticationDatabaseLive } from "../src/lib/authentication-database"
import { PostgresTest, TypedPostgresDrizzle } from "./postgres-test"

const TestLayer = Layer.provideMerge(
  PostgresAuthenticationDatabaseLive,
  PostgresTest,
)

const seedPasskeyIdentity = (suffix: string) =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const orgUnitId = `ou-passkey-${suffix}`
    const userId = `usr-passkey-${suffix}`

    yield* db.insert(schema.orgUnit).values({
      id: orgUnitId,
      name: `Passkey ${suffix}`,
      orgUnitLevel: "organisation",
      path: `/passkey-${suffix}`,
    })
    yield* db.insert(schema.user).values({
      id: userId,
      provider: "passkey",
      sub: `handle-${suffix}`,
      lastLoggedIn: DateTime.unsafeMake("2026-07-27T00:00:00.000Z"),
    })
    yield* db.insert(schema.providerUser).values({
      id: `pu-passkey-${suffix}`,
      userId,
      email: `${suffix}@example.com`,
      name: "Passkey User",
      firstName: "Passkey",
      lastName: "User",
      picture: "",
      locale: "en",
      orgUnitId,
    })

    return userId
  })

it.layer(TestLayer, { timeout: "60 seconds" })(
  "passkey credential persistence",
  (it) => {
    it.effect("creates and looks up zero and non-zero counters", () =>
      Effect.gen(function* () {
        const userId = yield* seedPasskeyIdentity("lookup")
        const authDb = yield* AuthenticationDatabase

        yield* authDb.createPasskeyCredential({
          userId,
          credentialId: "credential-zero",
          publicKey: "public-key-zero",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId,
          credentialId: "credential-non-zero",
          publicKey: "public-key-non-zero",
          counter: 42,
        })

        expect(
          Option.getOrThrow(
            yield* authDb.findPasskeyCredentialById("credential-zero"),
          ),
        ).toEqual({
          userId,
          email: "lookup@example.com",
          provider: "passkey",
          sub: "handle-lookup",
          credentialId: "credential-zero",
          publicKey: "public-key-zero",
          counter: 0,
        })
        expect(
          Option.getOrThrow(
            yield* authDb.findPasskeyCredentialById("credential-non-zero"),
          ),
        ).toEqual({
          userId,
          email: "lookup@example.com",
          provider: "passkey",
          sub: "handle-lookup",
          credentialId: "credential-non-zero",
          publicKey: "public-key-non-zero",
          counter: 42,
        })
      }),
    )

    it.effect(
      "compares counters before updating zero and non-zero values",
      () =>
        Effect.gen(function* () {
          const userId = yield* seedPasskeyIdentity("counter")
          const authDb = yield* AuthenticationDatabase

          yield* authDb.createPasskeyCredential({
            userId,
            credentialId: "credential-counter-zero",
            publicKey: "public-key-zero",
            counter: 0,
          })
          yield* authDb.createPasskeyCredential({
            userId,
            credentialId: "credential-counter-non-zero",
            publicKey: "public-key-non-zero",
            counter: 7,
          })

          expect(
            yield* authDb.advancePasskeyCredentialCounter(
              "credential-counter-zero",
              0,
              0,
            ),
          ).toBe(true)
          expect(
            yield* authDb.advancePasskeyCredentialCounter(
              "credential-counter-non-zero",
              7,
              8,
            ),
          ).toBe(true)
          expect(
            yield* authDb.advancePasskeyCredentialCounter(
              "credential-counter-non-zero",
              7,
              9,
            ),
          ).toBe(false)

          expect(
            Option.getOrThrow(
              yield* authDb.findPasskeyCredentialById(
                "credential-counter-zero",
              ),
            ).counter,
          ).toBe(0)
          expect(
            Option.getOrThrow(
              yield* authDb.findPasskeyCredentialById(
                "credential-counter-non-zero",
              ),
            ).counter,
          ).toBe(8)
        }),
    )

    it.effect("rejects duplicate active credential IDs", () =>
      Effect.gen(function* () {
        const userId = yield* seedPasskeyIdentity("unique")
        const authDb = yield* AuthenticationDatabase
        const credentialId = "credential-unique"

        yield* authDb.createPasskeyCredential({
          userId,
          credentialId,
          publicKey: "original-public-key",
          counter: 0,
        })
        const duplicate = yield* Effect.either(
          authDb.createPasskeyCredential({
            userId,
            credentialId,
            publicKey: "duplicate-public-key",
            counter: 1,
          }),
        )

        expect(Either.isLeft(duplicate)).toBe(true)
        expect(
          Option.getOrThrow(
            yield* authDb.findPasskeyCredentialById(credentialId),
          ).publicKey,
        ).toBe("original-public-key")
      }),
    )

    it.effect("lists unnamed credentials and renames without uniqueness", () =>
      Effect.gen(function* () {
        const userId = yield* seedPasskeyIdentity("manage")
        const otherId = yield* seedPasskeyIdentity("manage-other")
        const authDb = yield* AuthenticationDatabase

        yield* authDb.createPasskeyCredential({
          userId,
          credentialId: "credential-unnamed",
          publicKey: "public-key-unnamed",
          counter: 0,
        })
        yield* authDb.createPasskeyCredential({
          userId,
          credentialId: "credential-named",
          publicKey: "public-key-named",
          counter: 0,
          name: "Spare key",
        })
        yield* authDb.createPasskeyCredential({
          userId: otherId,
          credentialId: "credential-other",
          publicKey: "public-key-other",
          counter: 0,
          name: "Other key",
        })

        const listed = yield* authDb.listPasskeyCredentialsForUser(userId)
        const unnamed = listed.find((item) => item.name === null)
        expect(listed).toHaveLength(2)
        expect(unnamed).toBeDefined()
        expect(listed.every((item) => item.lastUsedAt === null)).toBe(true)
        expect(listed.some((item) => item.name === "Spare key")).toBe(true)
        expect(
          yield* authDb.renamePasskeyCredential({
            userId,
            id: unnamed?.id ?? "",
            name: "Spare key",
          }),
        ).toBe(true)
        expect(
          new Set(
            (yield* authDb.listPasskeyCredentialsForUser(userId)).map(
              (item) => item.name,
            ),
          ),
        ).toEqual(new Set(["Spare key"]))
        expect(
          yield* authDb.renamePasskeyCredential({
            userId: otherId,
            id: unnamed?.id ?? "",
            name: "Stolen",
          }),
        ).toBe(false)
        expect(
          (yield* authDb.listPasskeyCredentialsForUser(otherId)).map(
            (item) => item.name,
          ),
        ).toEqual(["Other key"])
      }),
    )

    it.effect(
      "records last-used independently of rename and account last login",
      () =>
        Effect.gen(function* () {
          const userId = yield* seedPasskeyIdentity("last-used")
          const authDb = yield* AuthenticationDatabase

          yield* authDb.createPasskeyCredential({
            userId,
            credentialId: "credential-used",
            publicKey: "public-key-used",
            counter: 0,
          })
          yield* authDb.createPasskeyCredential({
            userId,
            credentialId: "credential-idle",
            publicKey: "public-key-idle",
            counter: 7,
          })

          yield* authDb.updateLastLoggedIn(
            userId,
            DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
          )
          expect(
            (yield* authDb.listPasskeyCredentialsForUser(userId)).every(
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

          const db = yield* TypedPostgresDrizzle
          const rows = yield* db
            .select({
              id: schema.passkeyCredential.id,
              credentialId: schema.passkeyCredential.passkeyCredentialId,
            })
            .from(schema.passkeyCredential)
            .where(eq(schema.passkeyCredential.userId, userId))
          const usedId = rows.find(
            (row) => row.credentialId === "credential-used",
          )?.id
          const idleId = rows.find(
            (row) => row.credentialId === "credential-idle",
          )?.id
          const listed = yield* authDb.listPasskeyCredentialsForUser(userId)
          expect(listed.find((item) => item.id === usedId)?.lastUsedAt).toEqual(
            usedAt,
          )
          expect(
            listed.find((item) => item.id === idleId)?.lastUsedAt,
          ).toBeNull()

          expect(
            yield* authDb.renamePasskeyCredential({
              userId,
              id: usedId ?? "",
              name: "Laptop key",
            }),
          ).toBe(true)
          const afterRename =
            yield* authDb.listPasskeyCredentialsForUser(userId)
          expect(
            afterRename.find((item) => item.id === usedId)?.lastUsedAt,
          ).toEqual(usedAt)
          expect(
            afterRename.find((item) => item.id === idleId)?.lastUsedAt,
          ).toBeNull()
        }),
    )
  },
)
