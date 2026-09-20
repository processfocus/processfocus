import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Runtime,
} from "effect"
import { buildSchema } from "graphql"
import {
  AuthenticationDatabase,
  DelegationDatabase,
  DelegationSessionService,
  DelegationSessionServiceIsolated,
} from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigDefault,
} from "@pf/auth-local-cedar"
import * as schema from "@pf/drizzle-sqlite"
import { LocalDelegatedRealtime } from "@pf/graphql-api"
import {
  decodeDelegationAudit,
  encodeDelegationAudit,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteDelegationDatabaseLive,
} from "@pf/sqlite-operations"
import { buildPrincipal } from "../../../../packages/graphql-api/src/lib/authorization"
import {
  guardRealtimeStream,
  refreshRealtimeContext,
} from "../../../../packages/graphql-api/src/lib/delegated-realtime"
import { acceptVerifiedGraphqlJwt } from "../../../../packages/graphql-api/src/lib/delegation-boundary"
import { buildCurrentPrincipal } from "../../../../packages/graphql-api/src/lib/resolver-utils"
import { rejectUnsupportedDelegationHandoff } from "../../../../packages/graphql-api/src/lib/session-guards"
import type {
  JWTPayload,
  UserContext,
} from "../../../../packages/graphql-api/src/lib/types"
import {
  type EventHubService,
  createEventHubLayer,
} from "../services/event-hub"
import { describe, expect, it, setSystemTime } from "bun:test"

const TestLayer = SqliteAuthenticationDatabaseLive.pipe(
  Layer.provideMerge(DatabaseTest),
)
const base = Layer.mergeAll(
  TestLayer,
  SqliteDelegationDatabaseLive.pipe(Layer.provide(TestLayer)),
  LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const defaults = yield* LocalCedarConfig
          return {
            ...defaults,
            policiesText: [
              ...defaults.policiesText,
              'forbid (principal in PF::Role::"/Suspended", action == PF::Action::"login", resource);',
            ],
          }
        }),
      ).pipe(Layer.provide(LocalCedarConfigDefault())),
    ),
  ),
)
const isolated = DelegationSessionServiceIsolated.pipe(Layer.provideMerge(base))
const now = 1_800_000_000_000
const setup = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  yield* db
    .insert(schema.orgUnit)
    .values({ id: "ou-owner", name: "Root", orgUnitLevel: "root", path: "/" })
  yield* db.insert(schema.role).values({
    id: "role-owner",
    name: "Tester",
    orgUnitId: "ou-owner",
    path: "/Tester",
  })
  const authDb = yield* AuthenticationDatabase
  const owner = yield* authDb.createProviderUser({
    email: "owner@example.com",
    name: "Owner",
    firstName: "Owner",
    lastName: "",
    picture: "",
    locale: "en",
    provider: "passkey",
    sub: "owner",
    orgUnitId: "ou-owner",
  })
  yield* db.insert(schema.oauthProvider).values({
    providerName: "passkey",
    providerConfig: { delegatedAccess: true },
  })
  const store = yield* DelegationDatabase
  const ownerId = Option.getOrThrow(yield* store.findOwnerId(owner.id))
  yield* db
    .insert(schema.providerUserRole)
    .values({ providerUserId: ownerId, roleId: "role-owner" })
    .onConflictDoNothing()
  const secret = `pfds_${"c".repeat(43)}`
  yield* store.claimName({ id: "dlg-graphql", ownerId, name: "worker" })
  yield* store.insertGeneration({
    id: "dsg-graphql",
    delegationId: "dlg-graphql",
    verifier: createHash("sha256").update(secret).digest("base64url"),
    issuedAt: DateTime.unsafeMake(now),
    expiresAt: DateTime.unsafeMake(now + 120_000),
  })
  const properties = yield* (yield* DelegationSessionService).exchange(secret)
  const jwt = {
    mode: "access",
    type: "providerUser",
    properties,
    aud: "graphql-api",
    iss: "https://auth.example.com",
    sub: owner.id,
    exp: (now + 120_000) / 1000,
    iat: now / 1000,
  } satisfies JWTPayload
  return { jwt, db, ownerId, store, secret }
})

class Events extends Context.Tag("delegation-boundary-events")<
  Events,
  EventHubService<number>
>() {}
const eventSchema = buildSchema("type Query { value: Int }")
const realtime = Layer.mergeAll(
  isolated,
  LocalDelegatedRealtime.layer,
  createEventHubLayer(Events),
)

describe("local delegated realtime with real SQLite verifier and Cedar", () => {
  for (const ancestor of ["root", "middle"] as const) {
    for (const change of [
      "owner deleted",
      "login roles removed",
      "Cedar login denied",
    ] as const) {
      it(`rejects an open cross-owner descendant subscription after ${ancestor} ${change}, without affecting its human owner`, async () => {
        setSystemTime(now)
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const { jwt, db, ownerId, store } = yield* setup
              const authDb = yield* AuthenticationDatabase
              const verifier = yield* DelegationSessionService
              let ancestorOwnerId = ownerId
              let parentGenerationId = "dsg-graphql"
              for (const name of ["middle", "leaf"]) {
                const owner = yield* authDb.createProviderUser({
                  email: `${name}@example.com`,
                  name,
                  firstName: name,
                  lastName: "",
                  picture: "",
                  locale: "en",
                  provider: "passkey",
                  sub: name,
                  orgUnitId: "ou-owner",
                })
                const childOwnerId = Option.getOrThrow(
                  yield* store.findOwnerId(owner.id),
                )
                expect(childOwnerId).not.toBe(ownerId)
                if (ancestor === "middle" && name === "middle")
                  ancestorOwnerId = childOwnerId
                yield* db
                  .insert(schema.providerUserRole)
                  .values({
                    providerUserId: childOwnerId,
                    roleId: "role-owner",
                  })
                  .onConflictDoNothing()
                yield* store.claimName({
                  id: `dlg-${name}`,
                  ownerId: childOwnerId,
                  name,
                })
                yield* store.insertGeneration({
                  id: `dsg-${name}`,
                  delegationId: `dlg-${name}`,
                  parentGenerationId,
                  verifier: createHash("sha256")
                    .update(
                      `pfds_${(name === "middle" ? "m" : "l").repeat(43)}`,
                    )
                    .digest("base64url"),
                  issuedAt: DateTime.unsafeMake(now),
                  expiresAt: DateTime.unsafeMake(now + 120_000),
                })
                parentGenerationId = `dsg-${name}`
              }
              const properties = yield* verifier.exchange(
                `pfds_${"l".repeat(43)}`,
              )
              const leafJwt: JWTPayload = {
                ...jwt,
                sub: properties.userId,
                properties,
              }
              const humanJwt: JWTPayload = {
                ...leafJwt,
                properties: {
                  userId: properties.userId,
                  email: properties.email,
                  orgUnitId: properties.orgUnitId,
                  orgUnitPath: properties.orgUnitPath,
                  roles: properties.roles,
                },
              }
              const hub = yield* Events
              const run = Runtime.runPromise(yield* Effect.runtime<never>())
              const delegatedSource = yield* hub.subscribe()
              const humanSource = yield* hub.subscribe()
              let deliveries = 0
              const open = (
                source: AsyncIterable<number>,
                token: JWTPayload,
              ) => {
                const context: UserContext = {
                  jwt: token,
                  userId: properties.userId,
                  _requestTime: DateTime.unsafeMake(now),
                  _userDetails: { id: properties.userId, by: properties.email },
                }
                return guardRealtimeStream(source, {
                  context,
                  refresh: (signal) =>
                    run(
                      refreshRealtimeContext(context),
                      signal === undefined ? {} : { signal },
                    ),
                  deliver: async (event) => {
                    if (token === leafJwt) deliveries++
                    return event
                  },
                })
              }
              const delegated = open(delegatedSource, leafJwt)
              const human = open(humanSource, humanJwt)
              yield* Effect.promise(async () => {
                try {
                  await run(hub.emit(1, eventSchema))
                  expect(await delegated.next()).toEqual({
                    done: false,
                    value: 1,
                  })
                  expect(await human.next()).toEqual({ done: false, value: 1 })
                  switch (change) {
                    case "owner deleted":
                      await run(
                        db
                          .update(schema.providerUser)
                          .set({ _deleted: true })
                          .where(eq(schema.providerUser.id, ancestorOwnerId)),
                      )
                      break
                    case "login roles removed":
                      await run(
                        db
                          .update(schema.providerUserRole)
                          .set({ _deleted: true })
                          .where(
                            eq(
                              schema.providerUserRole.providerUserId,
                              ancestorOwnerId,
                            ),
                          ),
                      )
                      break
                    case "Cedar login denied":
                      await run(
                        db.insert(schema.role).values({
                          id: "role-suspended",
                          name: "Suspended",
                          orgUnitId: "ou-owner",
                          path: "/Suspended",
                        }),
                      )
                      await run(
                        db.insert(schema.providerUserRole).values({
                          providerUserId: ancestorOwnerId,
                          roleId: "role-suspended",
                        }),
                      )
                      break
                  }
                  // Only ancestor authority changed; the leaf's own owner stays valid.
                  expect(
                    Option.isSome(
                      await run(
                        authDb.findProviderUserByUserId(properties.userId),
                      ),
                    ),
                  ).toBe(true)
                  expect(
                    await run(authDb.findProviderUserRoles(properties.userId)),
                  ).toEqual(["/Tester"])
                  const leaf = Option.getOrThrow(
                    await run(
                      store.findGeneration({ generationId: "dsg-leaf" }),
                    ),
                  )
                  expect(leaf.parentGenerationId).toBe("dsg-middle")
                  expect(leaf.revokedAt).toBeNull()
                  expect(leaf.generationRevokedAt).toBeNull()
                  await run(hub.emit(2, eventSchema))
                  await expect(delegated.next()).rejects.toThrow(
                    "Subscription authorization or delivery failed",
                  )
                  expect(deliveries).toBe(1)
                  expect(await human.next()).toEqual({ done: false, value: 2 })
                } finally {
                  await delegated.return?.()
                  await human.return?.()
                }
              })
            }).pipe(
              Effect.provide(realtime),
              Effect.withClock(
                Object.assign(Clock.make(), {
                  currentTimeMillis: Effect.succeed(now),
                  unsafeCurrentTimeMillis: () => now,
                }),
              ),
            ),
          )
        } finally {
          setSystemTime()
        }
      })
    }
  }

  for (const change of [
    "expiry",
    "access token expiry",
    "replacement",
    "revoke",
    "owner deleted",
    "owner email",
    "login roles removed",
    "Cedar login denied",
  ] as const) {
    it(`rejects delivery and reconnect after ${change}`, async () => {
      let time = now
      setSystemTime(now)
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const { jwt, db, ownerId, store, secret } = yield* setup
            if (change === "access token expiry")
              jwt.exp = (now + 60_000) / 1000
            const verifier = yield* DelegationSessionService
            const hub = yield* Events
            const run = Runtime.runPromise(yield* Effect.runtime<never>())
            const context: UserContext = {
              jwt,
              userId: jwt.properties.userId,
              _requestTime: DateTime.unsafeMake(now),
              _userDetails: {
                id: jwt.properties.userId,
                by: jwt.properties.email,
              },
            }
            const source = yield* hub.subscribe()
            let deliveries = 0
            const stream = guardRealtimeStream(source, {
              context,
              refresh: (signal) =>
                run(refreshRealtimeContext(context), signal ? { signal } : {}),
              deliver: async (event) => {
                deliveries++
                return event
              },
            })
            yield* Effect.promise(async () => {
              await run(hub.emit(1, eventSchema))
              expect(await stream.next()).toEqual({ done: false, value: 1 })
            })
            switch (change) {
              case "expiry":
                time = now + 120_000
                break
              case "access token expiry":
                time = now + 60_000
                break
              case "replacement":
                yield* store.revokeGeneration({
                  generationId: "dsg-graphql",
                  revokedAt: DateTime.unsafeMake(time),
                })
                yield* store.insertGeneration({
                  id: "dsg-replacement",
                  delegationId: "dlg-graphql",
                  verifier: createHash("sha256")
                    .update(`pfds_${"d".repeat(43)}`)
                    .digest("base64url"),
                  issuedAt: DateTime.unsafeMake(time),
                  expiresAt: DateTime.unsafeMake(time + 120_000),
                })
                expect(
                  (yield* verifier.exchange(`pfds_${"d".repeat(43)}`))
                    .delegation.generationId,
                ).toBe("dsg-replacement")
                break
              case "revoke":
                yield* store.revoke({
                  id: "dlg-graphql",
                  revokedAt: DateTime.unsafeMake(time),
                })
                break
              case "owner deleted":
                yield* db
                  .update(schema.providerUser)
                  .set({ _deleted: true })
                  .where(eq(schema.providerUser.id, ownerId))
                break
              case "owner email":
                yield* db
                  .update(schema.providerUser)
                  .set({ email: "changed@example.com" })
                  .where(eq(schema.providerUser.id, ownerId))
                break
              case "login roles removed":
                yield* db
                  .update(schema.providerUserRole)
                  .set({ _deleted: true })
                  .where(eq(schema.providerUserRole.providerUserId, ownerId))
                break
              case "Cedar login denied":
                yield* db.insert(schema.role).values({
                  id: "role-suspended",
                  name: "Suspended",
                  orgUnitId: "ou-owner",
                  path: "/Suspended",
                })
                yield* db
                  .insert(schema.providerUserRole)
                  .values({ providerUserId: ownerId, roleId: "role-suspended" })
                break
            }
            yield* Effect.promise(async () => {
              try {
                await run(hub.emit(2, eventSchema))
                await expect(stream.next()).rejects.toThrow(
                  "Subscription authorization or delivery failed",
                )
                expect(deliveries).toBe(1)
                // A new connection must re-enter the real accepting boundary.
                await expect(
                  run(refreshRealtimeContext(context)),
                ).rejects.toThrow()
                await expect(stream.next()).rejects.toThrow()
              } finally {
                await stream.return?.()
              }
            })
            if (change === "access token expiry") {
              expect(
                (yield* verifier.exchange(secret)).delegation.generationId,
              ).toBe("dsg-graphql")
            } else if (change !== "owner email") {
              expect(
                Option.isNone(
                  yield* verifier.exchange(secret).pipe(Effect.option),
                ),
              ).toBe(true)
            }
          }).pipe(
            Effect.provide(realtime),
            Effect.withClock(
              Object.assign(Clock.make(), {
                currentTimeMillis: Effect.sync(() => time),
                unsafeCurrentTimeMillis: () => time,
              }),
            ),
          ),
        )
      } finally {
        setSystemTime()
      }
    })
  }

  it("refreshes roles independently, reconnects, and fails closed when the checker is unavailable", async () => {
    setSystemTime(now)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { jwt, db, ownerId } = yield* setup
          const hub = yield* Events
          const run = Runtime.runPromise(yield* Effect.runtime<never>())
          const context: UserContext = {
            jwt,
            userId: jwt.properties.userId,
            _requestTime: DateTime.unsafeMake(now),
            _userDetails: {
              id: jwt.properties.userId,
              by: jwt.properties.email,
            },
          }
          const firstSource = yield* hub.subscribe()
          const secondSource = yield* hub.subscribe()
          let unavailable = false
          const open = (source: AsyncIterable<number>) =>
            guardRealtimeStream(source, {
              context,
              refresh: (signal) =>
                unavailable
                  ? Effect.runPromise(
                      refreshRealtimeContext(context).pipe(
                        Effect.provide(LocalDelegatedRealtime.layer),
                      ),
                      { signal },
                    )
                  : run(
                      refreshRealtimeContext(context),
                      signal ? { signal } : {},
                    ),
              deliver: async (event, fresh) => ({
                event,
                roles: fresh.jwt?.properties.roles,
              }),
            })
          const first = open(firstSource)
          const second = open(secondSource)
          yield* db.insert(schema.role).values({
            id: "role-new",
            name: "New",
            orgUnitId: "ou-owner",
            path: "/New",
          })
          yield* db
            .insert(schema.providerUserRole)
            .values({ providerUserId: ownerId, roleId: "role-new" })
          yield* Effect.promise(async () => {
            try {
              await run(hub.emit(1, eventSchema))
              expect((await first.next()).value.roles).toContain("/New")
              expect((await second.next()).value.roles).toContain("/New")
              expect(jwt.properties.roles).toEqual(["/Tester"])
              const pending = first.next()
              await first.return?.()
              expect((await pending).done).toBe(true)
              await run(
                db
                  .update(schema.providerUserRole)
                  .set({ _deleted: true })
                  .where(eq(schema.providerUserRole.roleId, "role-new")),
              )
              await run(hub.emit(2, eventSchema))
              expect((await second.next()).value).toEqual({
                event: 2,
                roles: ["/Tester"],
              })
              const reconnect = open(await run(hub.subscribe()))
              try {
                await run(hub.emit(3, eventSchema))
                expect((await reconnect.next()).value.event).toBe(3)
                unavailable = true
                await expect(second.next()).rejects.toThrow(
                  "Subscription authorization or delivery failed",
                )
                await run(hub.emit(4, eventSchema))
                await expect(reconnect.next()).rejects.toThrow()
              } finally {
                await reconnect.return?.()
              }
            } finally {
              await first.return?.()
              await second.return?.()
            }
          })
        }).pipe(
          Effect.provide(realtime),
          Effect.withClock(
            Object.assign(Clock.make(), {
              currentTimeMillis: Effect.succeed(now),
              unsafeCurrentTimeMillis: () => now,
            }),
          ),
        ),
      )
    } finally {
      setSystemTime()
    }
  })
})

describe("GraphQL delegation accepting boundary with real SQLite and Cedar", () => {
  it("refreshes live facts, preserves a distinct principal, and rejects unsupported handoffs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { jwt, db, ownerId } = yield* setup
        const accepted = yield* acceptVerifiedGraphqlJwt(jwt)
        expect(accepted?.properties.roles).toEqual(["/Tester"])
        const context: UserContext = {
          jwt: accepted,
          userId: jwt.properties.userId,
          _requestTime: DateTime.unsafeMake(now),
          _userDetails: { by: "owner@example.com", id: jwt.properties.userId },
        }
        const principal = yield* buildPrincipal(context)
        expect(principal.uid).toEqual({
          type: "PF::Delegation",
          id: "dlg-graphql",
        })
        expect(buildCurrentPrincipal(context)?.uid).toEqual(principal.uid)
        for (const handoff of [
          "file download",
          "file upload",
          "database transfer",
          "impersonation",
          "subscription",
          "CLI",
        ]) {
          expect(
            Option.isNone(
              yield* rejectUnsupportedDelegationHandoff(
                jwt.properties,
                handoff,
              ).pipe(Effect.option),
            ),
          ).toBe(true)
        }
        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: true })
          .where(eq(schema.providerUserRole.providerUserId, ownerId))
        expect(
          Option.isNone(
            yield* acceptVerifiedGraphqlJwt(jwt).pipe(Effect.option),
          ),
        ).toBe(true)
        yield* db
          .update(schema.providerUser)
          .set({ _deleted: true })
          .where(eq(schema.providerUser.id, ownerId))
        expect(
          Option.isNone(
            yield* acceptVerifiedGraphqlJwt(jwt).pipe(Effect.option),
          ),
        ).toBe(true)
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

  it("rejects absent acceptance service, malformed generation, overlong credentials and exact expiry", async () => {
    let time = now
    await Effect.runPromise(
      Effect.gen(function* () {
        const { jwt } = yield* setup
        expect(
          Option.isNone(
            yield* acceptVerifiedGraphqlJwt({
              ...jwt,
              properties: { ...jwt.properties, delegation: undefined },
            }).pipe(Effect.option),
          ),
        ).toBe(true)
        expect(
          Option.isNone(
            yield* acceptVerifiedGraphqlJwt({ ...jwt, exp: jwt.exp + 1 }).pipe(
              Effect.option,
            ),
          ),
        ).toBe(true)
        const human: JWTPayload = {
          ...jwt,
          properties: {
            userId: jwt.properties.userId,
            email: "owner@example.com",
            orgUnitId: "/",
            orgUnitPath: "/",
            roles: [],
          },
        }
        expect(yield* acceptVerifiedGraphqlJwt(human)).toEqual(human)
        const withoutService = yield* Effect.promise(() =>
          Effect.runPromise(acceptVerifiedGraphqlJwt(jwt).pipe(Effect.option)),
        )
        expect(Option.isNone(withoutService)).toBe(true)
        time = now + 119_999
        expect(yield* acceptVerifiedGraphqlJwt(jwt)).toBeDefined()
        time++
        expect(
          Option.isNone(
            yield* acceptVerifiedGraphqlJwt(jwt).pipe(Effect.option),
          ),
        ).toBe(true)
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

  it("encodes immutable generation provenance rather than a mutable display name", () => {
    const actor = {
      version: 1 as const,
      ownerUserId: "usr-owner",
      ownerEmail: "owner@example.com",
      delegationId: "dlg-1",
      generationId: "dsg-1",
      name: 'worker via "another"',
    }
    expect(
      Option.getOrThrow(decodeDelegationAudit(encodeDelegationAudit(actor))),
    ).toEqual(actor)
    expect(Option.isNone(decodeDelegationAudit("owner@example.com"))).toBe(true)
    expect(Option.isNone(decodeDelegationAudit("pf:delegation:{bad"))).toBe(
      true,
    )
  })
})
