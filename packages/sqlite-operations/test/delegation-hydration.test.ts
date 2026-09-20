import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer, Option } from "effect"
import { DelegationDatabase } from "@pf/auth-api"
import { AuthenticationConfig } from "@pf/auth-config"
import * as schema from "@pf/drizzle-sqlite"
import { storeOrganisation } from "@pf/org-to-db"
import { Organisation } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteDelegationDatabaseLive } from "../src/lib/delegation-database"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { describe, expect, it } from "bun:test"

const now = DateTime.unsafeMake("2026-09-07T12:00:00Z")
const layer = Layer.mergeAll(
  DatabaseTest,
  SqliteDbOperationsLive,
  SqliteDelegationDatabaseLive.pipe(Layer.provide(DatabaseTest)),
  Layer.succeed(RequestTime, FiberRef.unsafeMake(now)),
)

const organisation = (
  mode: "enabled" | "disabled" | "absent" | "no-providers",
) => {
  const org = new Organisation({ name: "Delegation Hydration" })
  if (mode !== "absent") {
    new AuthenticationConfig(org, "auth", {
      delegatedAccess: mode !== "disabled",
      ...(mode === "no-providers"
        ? {}
        : {
            identityProviders: {
              google: {
                clientID: "google",
                clientSecret: "test-only",
                scopes: ["openid", "email"],
              },
            },
            passkey: {
              rpName: "Test",
              rpID: "localhost",
              origin: "http://localhost",
            },
          }),
    })
  }
  return org
}

const setup = Effect.gen(function* () {
  yield* storeOrganisation(organisation("enabled"))
  const db = yield* TypedSqliteDrizzle
  const store = yield* DelegationDatabase
  const [orgUnit] = yield* db.select().from(schema.orgUnit)
  yield* db.insert(schema.user).values({
    id: "u-owner",
    provider: "passkey",
    sub: "owner",
    lastLoggedIn: now,
  })
  yield* db.insert(schema.providerUser).values({
    id: "pu-owner",
    userId: "u-owner",
    orgUnitId: orgUnit!.id,
    email: "owner@example.com",
    name: "Owner",
    firstName: "Owner",
    lastName: "",
    picture: "",
    locale: "en",
  })
  expect(
    yield* store.claimName({
      id: "dlg-old",
      ownerId: "pu-owner",
      name: "agent",
    }),
  ).toBe(true)
  yield* store.insertGeneration({
    id: "dsg-old",
    delegationId: "dlg-old",
    verifier: "old-verifier",
    issuedAt: DateTime.subtract(now, { hours: 1 }),
    expiresAt: DateTime.add(now, { days: 7 }),
  })
  return { db, store }
})

describe("delegation configuration hydration", () => {
  for (const mode of ["disabled", "absent", "no-providers"] as const) {
    it(`preserves issued generations when login presentation is ${mode}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { db, store } = yield* setup
          const humanProviders = yield* db.select().from(schema.oauthProvider)
          const humans = yield* db.select().from(schema.providerUser)
          yield* storeOrganisation(organisation("enabled"))
          expect(
            Option.getOrThrow(
              yield* store.findGeneration({ generationId: "dsg-old" }),
            ).revokedAt,
          ).toBeNull()
          yield* storeOrganisation(organisation(mode))
          if (mode === "disabled") {
            const disabledProviders = yield* db
              .select()
              .from(schema.oauthProvider)
            expect(disabledProviders).toEqual(
              humanProviders.map((provider) => ({
                ...provider,
                providerConfig: {
                  ...provider.providerConfig,
                  delegatedAccess: false,
                },
              })),
            )
          }
          // Repeated hydration with the option hidden must not revoke credentials.
          const requestTime = yield* RequestTime
          yield* storeOrganisation(organisation(mode)).pipe(
            Effect.locally(requestTime, DateTime.add(now, { hours: 1 })),
          )
          const old = Option.getOrThrow(
            yield* store.findGeneration({ verifier: "old-verifier" }),
          )
          expect(old.revokedAt).toBeNull()
          expect(old.generationRevokedAt).toBeNull()
          expect((yield* store.list("pu-owner"))[0]!.revokedAt).toBeNull()
          expect(yield* store.isSecretLoginEnabled()).toBe(false)
          expect(yield* db.select().from(schema.providerUser)).toEqual(humans)

          // The active identity and name remain intact; showing the control again
          // changes presentation only.
          expect(
            yield* store.claimName({
              id: "dlg-conflict",
              ownerId: "pu-owner",
              name: "agent",
            }),
          ).toBe(false)
          yield* storeOrganisation(organisation("enabled"))
          expect(yield* store.isSecretLoginEnabled()).toBe(true)
          const providers = yield* db
            .select()
            .from(schema.oauthProvider)
            .where(eq(schema.oauthProvider._deleted, false))
          expect(
            providers.map(({ providerName, providerConfig }) => ({
              providerName,
              providerConfig,
            })),
          ).toEqual(
            humanProviders.map(({ providerName, providerConfig }) => ({
              providerName,
              providerConfig,
            })),
          )
          expect(
            Option.getOrThrow(
              yield* store.findGeneration({ generationId: "dsg-old" }),
            ).generationRevokedAt,
          ).toBeNull()

          // Independent explicit revocation remains permanent across either
          // presentation value and can never be resurrected by hydration.
          yield* store.revoke({ id: "dlg-old", revokedAt: now })
          yield* store.revokeGeneration({
            generationId: "dsg-old",
            revokedAt: now,
          })
          yield* storeOrganisation(organisation(mode))
          yield* storeOrganisation(organisation("enabled"))
          const oldAgain = Option.getOrThrow(
            yield* store.findGeneration({ generationId: "dsg-old" }),
          )
          expect(oldAgain.revokedAt).toEqual(now)
          expect(oldAgain.generationRevokedAt).toEqual(now)
        }).pipe(Effect.provide(layer)),
      ))
  }
})
