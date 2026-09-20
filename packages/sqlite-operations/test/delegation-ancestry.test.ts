import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect"
import {
  AuthenticationDatabase,
  DelegationDatabase,
  DelegationSessionService,
  DelegationSessionServiceIsolated,
  createAuthenticationServer,
  createClientJwt,
} from "@pf/auth-api"
import {
  CedarReloadNotifierService,
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigDefault,
  PolicyWatcherService,
} from "@pf/auth-local-cedar"
import * as schema from "@pf/drizzle-sqlite"
import { KeyManagementServiceLive, createTestApp } from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { SqliteDelegationDatabaseLive } from "../src/lib/delegation-database.js"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const now = 1_800_000_000_000
const deadline = now + 120_000
const base = Layer.mergeAll(
  TestLayer,
  SqliteDelegationDatabaseLive.pipe(Layer.provide(TestLayer)),
  KeyManagementServiceLive.pipe(Layer.provide(TestLayer)),
)
const cedar = LocalCedarAuthorizationLive.pipe(
  Layer.provide(LocalCedarConfigDefault()),
)
const isolated = DelegationSessionServiceIsolated.pipe(
  Layer.provideMerge(Layer.merge(base, cedar)),
)
const Tokens = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    expires_in: Schema.Number,
    refresh_expires_in: Schema.Number,
  }),
)

const setup = Effect.gen(function* () {
  const data = yield* setupTestData("root@example.com")
  const db = yield* TypedSqliteDrizzle
  const authDb = yield* AuthenticationDatabase
  const store = yield* DelegationDatabase
  yield* db.insert(schema.oauthProvider).values({
    providerName: "passkey",
    providerConfig: { delegatedAccess: true },
  })
  const owners: string[] = []
  const secrets: string[] = []
  for (const [index, name] of ["root", "middle", "leaf"].entries()) {
    const owner = yield* authDb.createProviderUser({
      email: `${name}@example.com`,
      name,
      firstName: name,
      lastName: "",
      picture: "",
      locale: "en",
      provider: "passkey",
      sub: name,
      orgUnitId: data.rootOrgUnitId,
    })
    const ownerId = Option.getOrThrow(yield* store.findOwnerId(owner.id))
    owners.push(ownerId)
    yield* db
      .insert(schema.providerUserRole)
      .values({
        providerUserId: ownerId,
        roleId: data.testerRoleId,
      })
      .onConflictDoNothing()
    const secret = `pfds_${String.fromCharCode(97 + index).repeat(43)}`
    secrets.push(secret)
    yield* store.claimName({ id: `dlg-${index}`, ownerId, name })
    yield* store.insertGeneration({
      id: `dsg-${index}`,
      delegationId: `dlg-${index}`,
      parentGenerationId: index === 0 ? null : `dsg-${index - 1}`,
      verifier: createHash("sha256").update(secret).digest("base64url"),
      issuedAt: DateTime.unsafeMake(now),
      expiresAt: DateTime.unsafeMake(deadline),
    })
    yield* store.recordIssuance({
      delegationId: `dlg-${index}`,
      generationId: `dsg-${index}`,
      actorId: index === 0 ? ownerId : owners[index - 1]!,
      actorDelegation:
        index === 0
          ? undefined
          : { id: `dlg-${index - 1}`, generationId: `dsg-${index - 1}` },
      issuedAt: DateTime.unsafeMake(now),
    })
  }
  const sessions = yield* DelegationSessionService
  const leaf = yield* sessions.exchange(secrets[2]!)
  const { app, runtime } = yield* createAuthenticationServer({
    clients: [
      {
        id: "frontend",
        redirectUris: ["https://app.example.com/callback"],
        tokenEndpointAuthMethod: "client_jwt",
      },
    ],
  })
  const server = createTestApp(app, { runtime })
  const bearer = yield* createClientJwt({
    clientId: "frontend",
    issuerUrl: "https://auth.example.com",
    audience: "frontend",
  })
  const exchange = () =>
    server.request("https://auth.example.com/oauth/delegation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: secrets[2] }),
    })
  const accept = (accessToken: string) =>
    server.request("https://auth.example.com/oauth/delegation/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accessToken }),
    })
  const refresh = (token: string, scope?: string) =>
    server.request("https://auth.example.com/oauth/token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        ...(scope === undefined ? {} : { scope }),
      }).toString(),
    })
  return {
    db,
    store,
    owners,
    secrets,
    sessions,
    leaf,
    exchange,
    accept,
    refresh,
  }
})

describe("immutable generation ancestry with migrated SQLite and real Cedar/auth", () => {
  for (const ancestor of [0, 1]) {
    for (const change of [
      "revocation",
      "replacement",
      "owner",
      "user",
      "roles",
      "expiry",
    ] as const) {
      it(`rejects leaf browser, refresh, CLI and secret use after ancestor ${ancestor} ${change}`, async () => {
        let time = now
        await Effect.runPromise(
          Effect.gen(function* () {
            const {
              db,
              store,
              owners,
              sessions,
              leaf,
              exchange,
              accept,
              refresh,
            } = yield* setup
            const issued = yield* Effect.promise(exchange)
            expect(issued.status).toBe(200)
            const browser = Tokens(yield* Effect.promise(() => issued.json()))
            const exported = yield* Effect.promise(() =>
              refresh(browser.refresh_token, "cli"),
            )
            expect(exported.status).toBe(200)
            const cli = Tokens(yield* Effect.promise(() => exported.json()))
            expect(cli.expires_in).toBe(120)
            expect(cli.refresh_expires_in).toBe(120)
            const generation = Option.getOrThrow(
              yield* store.findGeneration({ generationId: "dsg-2" }),
            )
            expect(generation.parentGenerationId).toBe("dsg-1")
            expect(leaf.delegation).toEqual({
              id: "dlg-2",
              generationId: "dsg-2",
              name: "leaf",
              expiresAt: deadline,
            })
            for (const tokens of [browser, cli])
              expect(
                (yield* Effect.promise(() => accept(tokens.access_token)))
                  .status,
              ).toBe(200)
            time = change === "expiry" ? deadline - 1 : now + 30_000
            yield* sessions.check(leaf)
            switch (change) {
              case "expiry":
                time++
                break
              case "revocation":
                yield* store.revoke({
                  id: `dlg-${ancestor}`,
                  revokedAt: DateTime.unsafeMake(time),
                })
                break
              case "replacement":
                yield* store.revokeGeneration({
                  generationId: `dsg-${ancestor}`,
                  revokedAt: DateTime.unsafeMake(time),
                })
                yield* store.recordChange({
                  delegationId: `dlg-${ancestor}`,
                  generationId: `dsg-${ancestor}`,
                  actorId: owners[ancestor]!,
                  event: "replaced",
                  occurredAt: DateTime.unsafeMake(time),
                })
                yield* store.insertGeneration({
                  id: "dsg-replacement",
                  delegationId: `dlg-${ancestor}`,
                  verifier: "replacement-verifier",
                  issuedAt: DateTime.unsafeMake(time),
                  expiresAt: DateTime.unsafeMake(deadline + 86400_000),
                })
                break
              case "owner":
                yield* db
                  .update(schema.providerUser)
                  .set({ _deleted: true })
                  .where(eq(schema.providerUser.id, owners[ancestor]!))
                break
              case "user": {
                const [owner] = yield* db
                  .select()
                  .from(schema.providerUser)
                  .where(eq(schema.providerUser.id, owners[ancestor]!))
                yield* db
                  .update(schema.user)
                  .set({ _deleted: true })
                  .where(eq(schema.user.id, owner!.userId))
                break
              }
              case "roles":
                yield* db
                  .update(schema.providerUserRole)
                  .set({ _deleted: true })
                  .where(
                    eq(
                      schema.providerUserRole.providerUserId,
                      owners[ancestor]!,
                    ),
                  )
                break
            }
            expect(yield* sessions.check(leaf).pipe(Effect.isFailure)).toBe(
              true,
            )
            expect((yield* Effect.promise(exchange)).status).toBe(400)
            for (const tokens of [browser, cli]) {
              expect(
                (yield* Effect.promise(() => accept(tokens.access_token)))
                  .status,
              ).toBe(401)
              for (const scope of [undefined, "cli", "role:/Tester"]) {
                expect(
                  (yield* Effect.promise(() =>
                    refresh(tokens.refresh_token, scope),
                  )).status,
                ).toBe(400)
              }
            }
            if (change !== "expiry") {
              // The leaf owner and own generation remain valid throughout.
              expect(
                Option.isSome(
                  yield* store.findGeneration({ generationId: "dsg-2" }),
                ),
              ).toBe(true)
              time += 60_000
              expect(yield* sessions.check(leaf).pipe(Effect.isFailure)).toBe(
                true,
              )
            }
          }).pipe(
            Effect.provide(isolated),
            Effect.withClock(
              Object.assign(Clock.make(), {
                currentTimeMillis: Effect.sync(() => time),
                unsafeCurrentTimeMillis: () => time,
              }),
            ),
          ),
        )
      })
    }
  }

  it("rejects lineage mutation, ID reuse, self/ancestor replacement, dangling and overlong children in storage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, store, owners, leaf, sessions } = yield* setup
        const sql = yield* SqlClient.SqlClient
        for (const query of [
          "UPDATE pf_secret_generation SET parent_secret_generation = NULL WHERE id = 'dsg-2'",
          "UPDATE pf_secret_generation SET parent_secret_generation = 'dsg-2' WHERE id = 'dsg-0'",
          "UPDATE pf_secret_generation SET id = 'other' WHERE id = 'dsg-0'",
          "UPDATE pf_secret_generation SET delegation_id = 'dlg-2' WHERE id = 'dsg-0'",
          "DELETE FROM pf_secret_generation WHERE id = 'dsg-2'",
          "INSERT OR REPLACE INTO pf_secret_generation SELECT * FROM pf_secret_generation WHERE id = 'dsg-2'",
        ])
          expect(yield* sql.unsafe(query).pipe(Effect.isFailure)).toBe(true)
        yield* store.claimName({
          id: "dlg-new",
          ownerId: owners[2]!,
          name: "new",
        })
        for (const [delegationId, parentGenerationId, expiresAt] of [
          ["dlg-new", "dsg-new", deadline],
          ["dlg-new", "missing", deadline],
          ["dlg-new", "dsg-2", deadline + 1000],
          ["dlg-0", "dsg-2", deadline],
          ["dlg-1", "dsg-2", deadline],
        ] as const) {
          expect(
            yield* store
              .insertGeneration({
                id: "dsg-new",
                delegationId,
                parentGenerationId,
                verifier: "new-verifier",
                issuedAt: DateTime.unsafeMake(now),
                expiresAt: DateTime.unsafeMake(expiresAt),
              })
              .pipe(Effect.isFailure),
          ).toBe(true)
        }
        yield* sessions.check(leaf)
        const history = yield* db
          .select()
          .from(schema.delegationHistory)
          .where(eq(schema.delegationHistory.delegationEvent, "issued"))
        expect(
          history.find((event) => event.secretGenerationId === "dsg-2"),
        ).toMatchObject({
          actorProviderUserId: owners[1],
          actorDelegationId: "dlg-1",
          actorSecretGenerationId: "dsg-1",
        })
        expect(
          Option.getOrThrow(
            yield* store.findGeneration({ generationId: "dsg-0" }),
          ).parentGenerationId,
        ).toBeNull()
      }).pipe(
        Effect.provide(isolated),
        Effect.withClock(
          Object.assign(Clock.make(), {
            currentTimeMillis: Effect.succeed(now),
            unsafeCurrentTimeMillis: () => now,
          }),
        ),
      ),
    )
  })

  for (const change of [
    "revocation",
    "replacement",
    "owner",
    "expiry",
  ] as const) {
    it(`rolls back stale child issuance when concurrent root ${change} wins`, async () => {
      let time = now
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db, store, owners, leaf, sessions } = yield* setup
          const sql = yield* SqlClient.SqlClient
          const checked = yield* Deferred.make<void>()
          const invalidated = yield* Deferred.make<void>()
          const issuance = yield* Effect.gen(function* () {
            yield* sessions.check(leaf)
            yield* Deferred.succeed(checked, undefined)
            yield* Deferred.await(invalidated)
            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* store.claimName({
                    id: "dlg-racing",
                    ownerId: owners[2]!,
                    name: "racing",
                  })
                  yield* store.insertGeneration({
                    id: "dsg-racing",
                    delegationId: "dlg-racing",
                    parentGenerationId: leaf.delegation.generationId,
                    verifier: "racing-verifier",
                    issuedAt: DateTime.unsafeMake(time),
                    expiresAt: DateTime.unsafeMake(deadline),
                  })
                }),
              )
              .pipe(Effect.isFailure)
          }).pipe(Effect.fork)
          yield* Deferred.await(checked)
          time = change === "expiry" ? deadline : now + 30_000
          yield* sql.withTransaction(
            Effect.gen(function* () {
              switch (change) {
                case "revocation":
                  yield* store.revoke({
                    id: "dlg-0",
                    revokedAt: DateTime.unsafeMake(time),
                  })
                  break
                case "replacement":
                  // History alone must invalidate a superseded issuing generation.
                  yield* store.recordChange({
                    delegationId: "dlg-0",
                    generationId: "dsg-0",
                    actorId: owners[0]!,
                    event: "replaced",
                    occurredAt: DateTime.unsafeMake(time),
                  })
                  break
                case "owner":
                  yield* db
                    .update(schema.providerUser)
                    .set({ _deleted: true })
                    .where(eq(schema.providerUser.id, owners[0]!))
                  break
                case "expiry":
                  break
              }
            }),
          )
          yield* Deferred.succeed(invalidated, undefined)
          expect(yield* Fiber.join(issuance)).toBe(true)
          expect(
            yield* db
              .select()
              .from(schema.delegation)
              .where(eq(schema.delegation.id, "dlg-racing")),
          ).toHaveLength(0)
          expect(
            Option.isNone(
              yield* store.findGeneration({ generationId: "dsg-racing" }),
            ),
          ).toBe(true)
          expect(yield* sessions.check(leaf).pipe(Effect.isFailure)).toBe(true)
        }).pipe(
          Effect.provide(isolated),
          Effect.withClock(
            Object.assign(Clock.make(), {
              currentTimeMillis: Effect.sync(() => time),
              unsafeCurrentTimeMillis: () => time,
            }),
          ),
        ),
      )
    })
  }

  it("fails closed on a corrupt cycle even if storage guards were bypassed", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sessions, leaf } = yield* setup
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe("DROP TRIGGER pf_secret_generation_lineage_immutable")
        yield* sql.unsafe(
          "UPDATE pf_secret_generation SET parent_secret_generation = 'dsg-2' WHERE id = 'dsg-0'",
        )
        expect(yield* sessions.check(leaf).pipe(Effect.isFailure)).toBe(true)
      }).pipe(
        Effect.provide(isolated),
        Effect.withClock(
          Object.assign(Clock.make(), {
            currentTimeMillis: Effect.succeed(now),
            unsafeCurrentTimeMillis: () => now,
          }),
        ),
      ),
    )
  })

  it("rechecks the root's current Cedar login policy after a live policy swap", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const defaults = yield* Layer.build(LocalCedarConfigDefault())
          const config = yield* LocalCedarConfig.pipe(Effect.provide(defaults))
          let policies = [...config.policiesText]
          const changes = yield* Queue.unbounded<void>()
          const reloaded = yield* Deferred.make<void>()
          const liveCedar = LocalCedarAuthorizationLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(LocalCedarConfig, {
                  ...config,
                  policiesText: policies,
                }),
                Layer.succeed(PolicyWatcherService, {
                  changes: Stream.fromQueue(changes),
                  currentPolicies: Effect.sync(() => policies),
                }),
                Layer.succeed(CedarReloadNotifierService, {
                  onCedarReloaded: () => {
                    Effect.runSync(Deferred.succeed(reloaded, undefined))
                  },
                }),
              ),
            ),
          )
          yield* Effect.gen(function* () {
            const { sessions, leaf, exchange, accept } = yield* setup
            const issued = yield* Effect.promise(exchange)
            const tokens = Tokens(yield* Effect.promise(() => issued.json()))
            expect(
              (yield* Effect.promise(() => accept(tokens.access_token))).status,
            ).toBe(200)
            policies = [
              ...policies,
              'forbid (principal == PF::Delegation::"dlg-0", action == PF::Action::"login", resource);',
            ]
            yield* Queue.offer(changes, undefined)
            yield* Deferred.await(reloaded).pipe(Effect.timeout("5 seconds"))
            expect(yield* sessions.check(leaf).pipe(Effect.isFailure)).toBe(
              true,
            )
            expect(
              (yield* Effect.promise(() => accept(tokens.access_token))).status,
            ).toBe(401)
            expect((yield* Effect.promise(exchange)).status).toBe(400)
          }).pipe(
            Effect.provide(
              DelegationSessionServiceIsolated.pipe(
                Layer.provideMerge(Layer.merge(base, liveCedar)),
              ),
            ),
          )
        }),
      ).pipe(
        Effect.withClock(
          Object.assign(Clock.make(), {
            currentTimeMillis: Effect.succeed(now),
            unsafeCurrentTimeMillis: () => now,
          }),
        ),
      ),
    )
  })
})
