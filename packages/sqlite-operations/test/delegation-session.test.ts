import { createHash } from "node:crypto"
import { HttpServerRequest } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import { Clock, DateTime, Effect, Layer, Logger, Option, Schema } from "effect"
import { SignJWT, jwtVerify } from "jose"
import {
  AuthenticationDatabase,
  DelegationDatabase,
  DelegationSessionService,
  DelegationSessionServiceIsolated,
  buildFrontendClients,
  createAuthenticationServer,
  createClientJwt,
} from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  LocalCedarConfigDefault,
} from "@pf/auth-local-cedar"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import {
  KeyManagementService,
  KeyManagementServiceLive,
  Storage,
  createTestApp,
  generateTokens,
} from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { SqliteDelegationDatabaseLive } from "../src/lib/delegation-database.js"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const base = Layer.mergeAll(
  TestLayer,
  SqliteDelegationDatabaseLive.pipe(Layer.provide(TestLayer)),
  KeyManagementServiceLive.pipe(Layer.provide(TestLayer)),
  LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const config = yield* LocalCedarConfig
          return {
            ...config,
            policiesText: [
              ...config.policiesText,
              `forbid (
              principal in PF::Role::"/LoginBlocked",
              action == PF::Action::"login",
              resource
            );

            permit (
              principal == PF::ProviderUser::"owner@example.com",
              action == PF::Action::"listDelegationTokens",
              resource == PF::ProviderUser::"owner@example.com"
            );

            permit (
              principal == PF::ProviderUser::"owner@example.com",
              action == PF::Action::"issueDelegationSecret",
              resource == PF::ProviderUser::"owner@example.com"
            )
            when {
              context.humanSession ||
              (context has humanAuthentication &&
                context.humanAuthentication.providerUserId == context.ownerProviderUserId &&
                context.humanAuthentication.method == "passkey")
            };`,
            ],
          }
        }),
      ).pipe(Layer.provide(LocalCedarConfigDefault())),
    ),
  ),
)
const isolated = DelegationSessionServiceIsolated.pipe(Layer.provideMerge(base))
const Tokens = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    expires_in: Schema.Number,
    refresh_expires_in: Schema.Number,
  }),
)
const now = Math.floor(Date.now() / 1000) * 1000
const setup = Effect.gen(function* () {
  const data = yield* setupTestData("owner@example.com")
  const db = yield* TypedSqliteDrizzle
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
    orgUnitId: data.rootOrgUnitId,
  })
  yield* db.insert(schema.oauthProvider).values({
    providerName: "passkey",
    providerConfig: {
      delegatedAccess: true,
      rpName: "Test",
      rpID: "auth.example.com",
      origin: "https://auth.example.com",
    },
  })
  const store = yield* DelegationDatabase
  const ownerId = yield* store.findOwnerId(owner.id)
  if (Option.isNone(ownerId)) throw new Error("Missing owner")
  yield* db
    .insert(schema.providerUserRole)
    .values({ providerUserId: ownerId.value, roleId: data.testerRoleId })
    .onConflictDoNothing()
  const secret = `pfds_${"a".repeat(43)}`
  yield* store.claimName({
    id: "dlg-test",
    ownerId: ownerId.value,
    name: "agent",
  })
  yield* store.insertGeneration({
    id: "dsg-test",
    delegationId: "dlg-test",
    verifier: createHash("sha256").update(secret).digest("base64url"),
    issuedAt: DateTime.unsafeMake(now),
    expiresAt: DateTime.unsafeMake(now + 120_000),
  })
  const { app, runtime } = yield* createAuthenticationServer({
    clients: [
      {
        id: "frontend",
        redirectUris: ["https://app.example.com/callback"],
        tokenEndpointAuthMethod: "client_jwt",
      },
      {
        id: "other",
        redirectUris: ["https://other.example.com/callback"],
        tokenEndpointAuthMethod: "client_jwt",
      },
    ],
  })
  const server = createTestApp(app, { runtime })
  const clientJwt = yield* createClientJwt({
    clientId: "frontend",
    issuerUrl: "https://auth.example.com",
    audience: "frontend",
  })
  const exchange = (
    body: unknown = { secret },
    bearer = clientJwt,
    suffix = "",
  ) =>
    server.request(`https://auth.example.com/oauth/delegation${suffix}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  const refresh = (token: string, scope?: string, bearer = clientJwt) =>
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
  const acceptSession = (accessToken: string, bearer = clientJwt) =>
    server.request("https://auth.example.com/oauth/delegation/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accessToken }),
    })
  const key = yield* (yield* KeyManagementService).signingKey
  const verify = (token: string, at = now) =>
    Effect.tryPromise(async () => {
      const verified = await jwtVerify(token, key.public, {
        issuer: "https://auth.example.com",
        audience: "frontend",
        currentDate: new Date(at),
      })
      const parsed = await subjects.providerUser["~standard"].validate(
        verified.payload["properties"],
      )
      if (parsed.issues) throw new Error("Invalid subject")
      return {
        properties: parsed.value,
        expiresAt: verified.payload.exp! * 1000,
      }
    })
  return {
    server,
    key,
    db,
    store,
    secret,
    owner,
    ownerId: ownerId.value,
    exchange,
    refresh,
    verify,
    acceptSession,
    availability: (bearer = clientJwt) =>
      server.request("https://auth.example.com/oauth/delegation/availability", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
  }
})

describe("isolated delegated session HTTP, signed credentials and SQLite", () => {
  for (const [deadline, elapsed, lifetime] of [
    [120_000, 118_999, 1],
    [120_000, 119_000, 1],
    [120_000, 119_001, 0],
    [120_000, 119_999, 0],
    [120_000, 120_000, 0],
  ] as const) {
    it(`caps CLI export at deadline ${deadline} after ${elapsed}ms without zero-lifetime success`, async () => {
      let time = now
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db, exchange, refresh, verify, acceptSession } = yield* setup
          yield* db.update(schema.secretGeneration).set({
            secretExpiresAt: DateTime.unsafeMake(now + deadline),
          })
          const response = yield* Effect.promise(() => exchange())
          const browser = Tokens(yield* Effect.promise(() => response.json()))
          const refreshParts = browser.refresh_token.split(":")
          const refreshId = refreshParts.pop()!
          const subject = refreshParts.join(":")
          const payload = yield* Storage.get<{ nextToken: string }>([
            "oauth:refresh",
            subject,
            refreshId,
          ])
          time += elapsed
          const exported = yield* Effect.promise(() =>
            refresh(browser.refresh_token, "cli"),
          )
          if (lifetime === 0) {
            expect(exported.status).toBe(400)
            expect(yield* Effect.promise(() => exported.json())).toMatchObject({
              error: "invalid_grant",
            })
            expect(
              yield* Storage.get([
                "oauth:refresh",
                subject,
                payload!.nextToken,
              ]),
            ).toBeUndefined()
            return
          }
          expect(exported.status).toBe(200)
          expect(exported.headers.get("cache-control")).toBe("no-store")
          const cli = Tokens(yield* Effect.promise(() => exported.json()))
          expect(cli.expires_in).toBe(lifetime)
          const signed = yield* verify(cli.access_token, time)
          expect(signed.expiresAt).toBe(now + deadline)
          expect(signed.properties).toEqual(
            (yield* verify(browser.access_token, time)).properties,
          )
          expect(
            (yield* Effect.promise(() => acceptSession(cli.access_token)))
              .status,
          ).toBe(200)
          time = now + deadline
          expect(
            yield* verify(cli.access_token, time).pipe(Effect.isFailure),
          ).toBe(true)
          expect(
            (yield* Effect.promise(() => acceptSession(cli.access_token)))
              .status,
          ).toBe(401)
          expect(
            (yield* Effect.promise(() => refresh(cli.refresh_token, "cli")))
              .status,
          ).toBe(400)
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

  it("limits CLI override to eight hours and does not persist it to browser refresh", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange, refresh, verify } = yield* setup
        yield* db
          .update(schema.secretGeneration)
          .set({ secretExpiresAt: DateTime.unsafeMake(now + 86400_000) })
        const issued = yield* Effect.promise(() => exchange())
        const browser = Tokens(yield* Effect.promise(() => issued.json()))
        const exported = yield* Effect.promise(() =>
          refresh(browser.refresh_token, "cli"),
        )
        const cli = Tokens(yield* Effect.promise(() => exported.json()))
        expect(cli.expires_in).toBe(8 * 3600)
        expect((yield* verify(cli.access_token)).properties).toEqual(
          (yield* verify(browser.access_token)).properties,
        )
        const refreshed = yield* Effect.promise(() =>
          refresh(cli.refresh_token),
        )
        const next = Tokens(yield* Effect.promise(() => refreshed.json()))
        expect(next.expires_in).toBe(600)
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

  for (const configuration of ["default", "env", "jwt"] as const) {
    it(`allows only the ${configuration} frontend client to exchange a secret and export signed delegated CLI credentials`, async () => {
      const originalClientId = process.env["OAUTH_CLIENT_ID"]
      const originalFrontendJwt = process.env["FRONTEND_JWT_TOKEN"]
      const originalNodeEnv = process.env["NODE_ENV"]
      const originalClients = process.env["OPENAUTH_CLIENTS"]
      const originalAudience = process.env["OAUTH_AUDIENCE"]
      delete process.env["OAUTH_CLIENT_ID"]
      delete process.env["FRONTEND_JWT_TOKEN"]
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const { exchange, verify, key, secret } = yield* setup
            const issued = yield* Effect.promise(() => exchange())
            const browser = Tokens(yield* Effect.promise(() => issued.json()))
            const properties = (yield* verify(browser.access_token)).properties
            const frontendClientId =
              configuration === "default" ? "frontend" : "configured-frontend"
            if (configuration !== "default") {
              process.env["OAUTH_CLIENT_ID"] =
                configuration === "jwt" ? "env-frontend" : frontendClientId
            }
            if (configuration === "jwt") {
              process.env["NODE_ENV"] = "development"
              delete process.env["OPENAUTH_CLIENTS"]
              process.env["OAUTH_AUDIENCE"] = "wrong-env-audience"
              process.env["FRONTEND_JWT_TOKEN"] = yield* createClientJwt({
                clientId: frontendClientId,
                issuerUrl: "https://auth.example.com",
                audience: "configured-api",
              })
            }
            const clientIds = [
              ...new Set([frontendClientId, "frontend", "other"]),
            ]
            const { app, runtime } = yield* createAuthenticationServer({
              clients: [
                ...(configuration === "jwt"
                  ? yield* Effect.promise(buildFrontendClients)
                  : []),
                ...clientIds
                  .filter(
                    (id) => configuration !== "jwt" || id !== frontendClientId,
                  )
                  .map((id) => ({
                    id,
                    redirectUris: ["https://app.example.com/callback"],
                    tokenEndpointAuthMethod: "client_jwt" as const,
                  })),
              ],
            })
            const server = createTestApp(app, { runtime })
            for (const clientId of clientIds) {
              const bearer = yield* createClientJwt({
                clientId,
                issuerUrl: "https://auth.example.com",
                audience:
                  configuration === "jwt" && clientId === frontendClientId
                    ? "configured-api"
                    : clientId,
              })
              const available = yield* Effect.promise(() =>
                server.request(
                  "https://auth.example.com/oauth/delegation/availability",
                  { headers: { authorization: `Bearer ${bearer}` } },
                ),
              )
              expect(available.status).toBe(
                clientId === frontendClientId ? 200 : 401,
              )
              expect(yield* Effect.promise(() => available.json())).toEqual(
                clientId === frontendClientId
                  ? { secretLoginEnabled: true }
                  : { error: "invalid_client" },
              )
              const exchanged = yield* Effect.promise(() =>
                server.request("https://auth.example.com/oauth/delegation", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ secret }),
                }),
              )
              expect(exchanged.status).toBe(
                clientId === frontendClientId ? 200 : 401,
              )
              if (clientId !== frontendClientId) {
                expect(yield* Effect.promise(() => exchanged.json())).toEqual({
                  error: "invalid_client",
                })
              }
              // Only the rejection probe needs a credential minted for another client.
              const refreshToken =
                clientId === frontendClientId
                  ? Tokens(yield* Effect.promise(() => exchanged.json()))
                      .refresh_token
                  : (yield* generateTokens({
                      type: "providerUser",
                      properties,
                      subject: "delegation:dlg-test:dsg-test",
                      clientID: clientId,
                      audience: undefined,
                      ttl: { access: 600, refresh: 600 },
                      expiresAt: now + 120_000,
                      timeUsed: undefined,
                      nextToken: undefined,
                    }).pipe(
                      Effect.provideService(
                        HttpServerRequest.HttpServerRequest,
                        HttpServerRequest.fromWeb(
                          new Request("https://auth.example.com/oauth/token", {
                            headers: {
                              host: "auth.example.com",
                              "x-forwarded-proto": "https",
                            },
                          }),
                        ),
                      ),
                    )).refresh!
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
              const ordinary = yield* Effect.promise(() =>
                refresh(refreshToken),
              )
              expect(ordinary.status).toBe(200)
              const rotated = Tokens(
                yield* Effect.promise(() => ordinary.json()),
              )
              const exported = yield* Effect.promise(() =>
                refresh(rotated.refresh_token, "cli"),
              )
              if (clientId !== frontendClientId) {
                expect(exported.status).toBe(400)
                expect(
                  yield* Effect.promise(() => exported.json()),
                ).toMatchObject({ error: "invalid_grant" })
                continue
              }
              expect(exported.status).toBe(200)
              const cli = Tokens(yield* Effect.promise(() => exported.json()))
              const signed = yield* Effect.promise(() =>
                jwtVerify(cli.access_token, key.public, {
                  issuer: "https://auth.example.com",
                  audience:
                    configuration === "jwt"
                      ? "configured-api"
                      : frontendClientId,
                  currentDate: new Date(now),
                }),
              )
              expect(signed.payload["properties"]).toEqual(properties)
              expect(signed.payload.exp).toBe((now + 120_000) / 1000)
              expect(cli.expires_in).toBe(120)
              for (const acceptingClientId of clientIds) {
                const acceptingBearer = yield* createClientJwt({
                  clientId: acceptingClientId,
                  issuerUrl: "https://auth.example.com",
                  audience:
                    configuration === "jwt" &&
                    acceptingClientId === frontendClientId
                      ? "configured-api"
                      : acceptingClientId,
                })
                const accepted = yield* Effect.promise(() =>
                  server.request(
                    "https://auth.example.com/oauth/delegation/session",
                    {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${acceptingBearer}`,
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({ accessToken: cli.access_token }),
                    },
                  ),
                )
                expect(accepted.status).toBe(
                  acceptingClientId === frontendClientId ? 200 : 401,
                )
                expect(yield* Effect.promise(() => accepted.json())).toEqual(
                  acceptingClientId === frontendClientId
                    ? { session: properties }
                    : { error: "invalid_client" },
                )
              }
            }
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
      } finally {
        if (originalClientId === undefined)
          delete process.env["OAUTH_CLIENT_ID"]
        else process.env["OAUTH_CLIENT_ID"] = originalClientId
        if (originalFrontendJwt === undefined)
          delete process.env["FRONTEND_JWT_TOKEN"]
        else process.env["FRONTEND_JWT_TOKEN"] = originalFrontendJwt
        if (originalNodeEnv === undefined) delete process.env["NODE_ENV"]
        else process.env["NODE_ENV"] = originalNodeEnv
        if (originalClients === undefined)
          delete process.env["OPENAUTH_CLIENTS"]
        else process.env["OPENAUTH_CLIENTS"] = originalClients
        if (originalAudience === undefined) delete process.env["OAUTH_AUDIENCE"]
        else process.env["OAUTH_AUDIENCE"] = originalAudience
      }
    })
  }

  for (const change of ["roles", "owner", "login", "storage"] as const) {
    it(`rejects exported signed access and browser/CLI refresh after live ${change} invalidation`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db, ownerId, exchange, refresh, verify, acceptSession } =
            yield* setup
          const issued = yield* Effect.promise(() => exchange())
          const browser = Tokens(yield* Effect.promise(() => issued.json()))
          const exported = yield* Effect.promise(() =>
            refresh(browser.refresh_token, "cli"),
          )
          const cli = Tokens(yield* Effect.promise(() => exported.json()))
          const signed = yield* verify(cli.access_token)
          expect(
            (yield* Effect.promise(() => acceptSession(cli.access_token)))
              .status,
          ).toBe(200)
          switch (change) {
            case "roles":
              yield* db
                .update(schema.providerUserRole)
                .set({ _deleted: true })
                .where(eq(schema.providerUserRole.providerUserId, ownerId))
              break
            case "owner":
              yield* db
                .update(schema.providerUser)
                .set({ _deleted: true })
                .where(eq(schema.providerUser.id, ownerId))
              break
            case "login": {
              const [role] = yield* db
                .insert(schema.role)
                .values({
                  name: "LoginBlocked",
                  path: "/LoginBlocked",
                  orgUnitId: signed.properties.orgUnitId,
                })
                .returning()
              yield* db
                .insert(schema.providerUserRole)
                .values({ providerUserId: ownerId, roleId: role!.id })
              break
            }
            case "storage": {
              const sql = yield* SqlClient.SqlClient
              yield* sql.unsafe(
                "ALTER TABLE pf_secret_generation RENAME TO unavailable_secret_generation",
              )
              break
            }
          }
          for (const tokens of [browser, cli]) {
            yield* verify(tokens.access_token)
            expect(
              (yield* Effect.promise(() => acceptSession(tokens.access_token)))
                .status,
            ).toBe(401)
            for (const scope of [undefined, "cli", "role:%2FTester"])
              expect(
                (yield* Effect.promise(() =>
                  refresh(tokens.refresh_token, scope),
                )).status,
              ).toBe(400)
          }
        }).pipe(Effect.provide(isolated)),
      )
    })
  }

  for (const explicit of [false, true]) {
    it(`checks signed delegated management without the isolated service (${explicit ? "explicit grants" : "ungranted"}) while exchange fails without its service`, async () => {
      const policy = Layer.effect(
        LocalCedarConfig,
        Effect.gen(function* () {
          const defaults = yield* LocalCedarConfig
          return {
            ...defaults,
            policiesText: [
              ...defaults.policiesText,
              ...(explicit
                ? [
                    `permit (principal == PF::Delegation::"dlg-test", action in [PF::Action::"listDelegationTokens", PF::Action::"revokeDelegation", PF::Action::"replaceDelegation", PF::Action::"issueDelegationSecret"], resource);`,
                  ]
                : []),
            ],
          }
        }),
      ).pipe(Layer.provide(LocalCedarConfigDefault()))
      const managementLayer = Layer.mergeAll(
        TestLayer,
        SqliteDelegationDatabaseLive.pipe(Layer.provide(TestLayer)),
        KeyManagementServiceLive.pipe(Layer.provide(TestLayer)),
        LocalCedarAuthorizationLive.pipe(Layer.provide(policy)),
      )
      let time = now
      const clock = Object.assign(Clock.make(), {
        unsafeCurrentTimeMillis: () => time,
        currentTimeMillis: Effect.sync(() => time),
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          expect(
            Option.isNone(
              yield* Effect.serviceOption(DelegationSessionService),
            ),
          ).toBe(true)
          const {
            server,
            key,
            db,
            store,
            owner,
            ownerId,
            availability,
            exchange,
            acceptSession,
          } = yield* setup
          const sign = (expiresAt = now + 120_000) =>
            new SignJWT({
              mode: "access",
              type: "providerUser",
              properties: {
                userId: owner.id,
                email: owner.email,
                orgUnitId: owner.orgUnitId,
                orgUnitPath: "/",
                roles: [],
                delegation: {
                  id: "dlg-test",
                  generationId: "dsg-test",
                  name: "agent",
                  expiresAt,
                },
              },
            })
              .setProtectedHeader({ alg: key.alg, kid: key.id })
              .setIssuer("https://auth.example.com")
              .setAudience("frontend")
              .setSubject("delegation:dlg-test:dsg-test")
              .setIssuedAt(Math.floor(now / 1000))
              .setExpirationTime(Math.floor(now / 1000) + 3600)
              .sign(key.private)
          const token = yield* Effect.promise(() => sign())
          const request = (method: string, bearer = token, body?: unknown) =>
            server.request("https://auth.example.com/delegations", {
              method,
              headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/json",
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          yield* store.claimName({ id: "dlg-target", ownerId, name: "target" })
          yield* store.insertGeneration({
            id: "dsg-target",
            delegationId: "dlg-target",
            verifier: createHash("sha256")
              .update("target-secret")
              .digest("base64url"),
            issuedAt: DateTime.unsafeMake(now),
            expiresAt: DateTime.unsafeMake(now + 120_000),
          })
          const guard = {
            id: "dlg-target",
            generationId: "dsg-target",
            expectedName: "target",
          }
          const available = yield* Effect.promise(() => availability())
          expect(available.status).toBe(200)
          expect(yield* Effect.promise(() => available.json())).toEqual({
            secretLoginEnabled: true,
          })
          for (const response of [
            yield* Effect.promise(() => exchange()),
            yield* Effect.promise(() => acceptSession(token)),
          ]) {
            expect(response.status).toBe(403)
            expect(yield* Effect.promise(() => response.json())).toEqual({
              error: "delegated_access_unavailable",
            })
          }
          const listed = yield* Effect.promise(() => request("GET"))
          expect(listed.status).toBe(explicit ? 200 : 403)
          if (explicit) {
            const result = Schema.decodeUnknownSync(
              Schema.Struct({
                canIssue: Schema.Boolean,
                delegations: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    allowedActions: Schema.Struct({
                      replace: Schema.Boolean,
                      revoke: Schema.Boolean,
                    }),
                  }),
                ),
              }),
            )(yield* Effect.promise(() => listed.json()))
            expect(result.canIssue).toBe(true)
            expect(result.delegations).toHaveLength(2)
            expect(
              result.delegations.every(
                (record) =>
                  record.allowedActions.revoke &&
                  record.allowedActions.replace === (record.id !== "dlg-test"),
              ),
            ).toBe(true)
          } else {
            expect(yield* Effect.promise(() => listed.json())).toEqual({
              error: "issuance_denied",
            })
          }
          for (const [method, body] of [
            ["POST", { name: "child", lifetimeDays: 1 }],
            [
              "PATCH",
              {
                operation: "replace",
                ...guard,
                name: "target",
                lifetimeDays: 1,
              },
            ],
          ] as const) {
            // Explicit issuance/replacement is covered by the management
            // lifecycle tests; this probe checks implicit deny without grants.
            if (explicit) continue
            const denied = yield* Effect.promise(() =>
              request(method, token, body),
            )
            expect(denied.status).toBe(403)
            expect(yield* Effect.promise(() => denied.json())).toEqual({
              error: method === "POST" ? "issuance_denied" : "operation_denied",
            })
          }
          const revoked = yield* Effect.promise(() =>
            request("PATCH", token, { operation: "revoke", ...guard }),
          )
          expect(revoked.status).toBe(explicit ? 200 : 403)
          const history = yield* db.select().from(schema.delegationHistory)
          expect(history).toHaveLength(explicit ? 1 : 0)
          if (explicit)
            expect(history[0]).toMatchObject({
              delegationEvent: "revoked",
              actorDelegationId: "dlg-test",
              actorSecretGenerationId: "dsg-test",
            })
          // JWT expiry remains in the future; live generation validity must win over Cedar grants.
          yield* db
            .update(schema.secretGeneration)
            .set({ secretExpiresAt: DateTime.unsafeMake(now + 1000) })
            .where(eq(schema.secretGeneration.id, "dsg-test"))
          const expiring = yield* Effect.promise(() => sign(now + 1000))
          time += 1000
          for (const bearer of [expiring, token]) {
            for (const method of ["GET", "PATCH"]) {
              const denied = yield* Effect.promise(() =>
                request(
                  method,
                  bearer,
                  method === "PATCH"
                    ? { operation: "revoke", ...guard }
                    : undefined,
                ),
              )
              expect(denied.status).toBe(401)
              expect(yield* Effect.promise(() => denied.json())).toEqual({
                error: "invalid_token",
              })
            }
          }
          yield* db
            .update(schema.secretGeneration)
            .set({ secretExpiresAt: DateTime.unsafeMake(now + 120_000) })
            .where(eq(schema.secretGeneration.id, "dsg-test"))
          yield* store.revoke({
            id: "dlg-test",
            revokedAt: DateTime.unsafeMake(time),
          })
          for (const method of ["GET", "PATCH"]) {
            const denied = yield* Effect.promise(() =>
              request(
                method,
                token,
                method === "PATCH"
                  ? { operation: "revoke", ...guard }
                  : undefined,
              ),
            )
            expect(denied.status).toBe(401)
            expect(yield* Effect.promise(() => denied.json())).toEqual({
              error: "invalid_token",
            })
          }
          expect(
            (yield* db.select().from(schema.delegationHistory)).some(
              (event) => event.delegationEvent === "login",
            ),
          ).toBe(false)
          expect(yield* db.select().from(schema.secretGeneration)).toHaveLength(
            2,
          )
        }).pipe(Effect.provide(managementLayer), Effect.withClock(clock)),
      )
    })
  }

  for (const elapsed of [30_000, 120_000]) {
    it(`replaces ${elapsed === 30_000 ? "live" : "expired"} access through the owner API and immediately rejects old secrets, access and refresh credentials`, async () => {
      let time = now
      const clock = Object.assign(Clock.make(), {
        unsafeCurrentTimeMillis: () => time,
        currentTimeMillis: Effect.sync(() => time),
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          const {
            server,
            key,
            owner,
            exchange,
            refresh,
            acceptSession,
            verify,
            secret,
            db,
          } = yield* setup
          const initialResponse = yield* Effect.promise(() => exchange())
          expect(initialResponse.status).toBe(200)
          const browser = Tokens(
            yield* Effect.promise(() => initialResponse.json()),
          )
          const exported = yield* Effect.promise(() =>
            refresh(browser.refresh_token, "cli"),
          )
          expect(exported.status).toBe(200)
          const initial = Tokens(yield* Effect.promise(() => exported.json()))
          const session = (yield* verify(initial.access_token)).properties
          const sessions = yield* DelegationSessionService
          time += elapsed
          if (elapsed < 120_000) {
            yield* verify(initial.access_token, time)
            expect(
              (yield* Effect.promise(() => acceptSession(initial.access_token)))
                .status,
            ).toBe(200)
          } else {
            expect((yield* Effect.promise(() => exchange())).status).toBe(400)
            expect(
              (yield* Effect.promise(() => acceptSession(initial.access_token)))
                .status,
            ).toBe(401)
            expect(
              (yield* Effect.promise(() => acceptSession(browser.access_token)))
                .status,
            ).toBe(401)
          }
          const human = yield* Effect.promise(() =>
            new SignJWT({
              mode: "access",
              type: "providerUser",
              properties: {
                ...session,
                delegation: undefined,
                humanAuthentication: {
                  providerUserId: owner.id,
                  authenticatedAt: time,
                  method: "passkey",
                },
              },
            })
              .setProtectedHeader({ alg: key.alg, kid: key.id })
              .setIssuer("https://auth.example.com")
              .setAudience("frontend")
              .setSubject(`providerUser:${owner.id}`)
              .setIssuedAt(time / 1000)
              .setExpirationTime(time / 1000 + 3600)
              .sign(key.private),
          )
          const change = (body: unknown) =>
            server.request("https://auth.example.com/delegations", {
              method: "PATCH",
              headers: {
                authorization: `Bearer ${human}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            })
          const replacement = yield* Effect.promise(() =>
            change({
              operation: "replace",
              id: "dlg-test",
              generationId: "dsg-test",
              expectedName: "agent",
              name: "replacement-agent",
              lifetimeDays: 7,
            }),
          )
          expect(replacement.status).toBe(200)
          const next = Schema.decodeUnknownSync(
            Schema.Struct({
              id: Schema.String,
              generationId: Schema.String,
              secret: Schema.String,
              name: Schema.String,
              expiresAt: Schema.String,
              lastUsedAt: Schema.NullOr(Schema.String),
            }),
          )(yield* Effect.promise(() => replacement.json()))
          expect(next.id).toBe("dlg-test")
          expect(next.generationId).not.toBe("dsg-test")
          expect(next.secret).not.toBe(secret)
          expect(next.lastUsedAt).toBeNull()
          expect(Date.parse(next.expiresAt)).toBe(time + 7 * 86400000)
          // These old access credentials have real valid signatures, not altered bytes.
          for (const advance of [0, 59_000, 60_000]) {
            time = now + elapsed + advance
            const denied = yield* Effect.promise(() => exchange())
            expect(denied.status).toBe(400)
            expect(yield* Effect.promise(() => denied.json())).toEqual({
              error: "invalid_grant",
            })
            expect(
              (yield* Effect.promise(() => acceptSession(initial.access_token)))
                .status,
            ).toBe(401)
            expect(
              (yield* Effect.promise(() => refresh(initial.refresh_token)))
                .status,
            ).not.toBe(200)
            expect(
              (yield* Effect.promise(() =>
                refresh(initial.refresh_token, "role:/Tester"),
              )).status,
            ).not.toBe(200)
            expect(yield* sessions.check(session).pipe(Effect.isFailure)).toBe(
              true,
            )
          }
          const nextLogin = yield* Effect.promise(() =>
            exchange({ secret: next.secret }),
          )
          expect(nextLogin.status).toBe(200)
          const replacementBrowser = Tokens(
            yield* Effect.promise(() => nextLogin.json()),
          )
          const nextExport = yield* Effect.promise(() =>
            refresh(replacementBrowser.refresh_token, "cli"),
          )
          expect(nextExport.status).toBe(200)
          const newTokens = Tokens(
            yield* Effect.promise(() => nextExport.json()),
          )
          const newSession = (yield* verify(newTokens.access_token, time))
            .properties
          expect(newSession.delegation).toMatchObject({
            id: "dlg-test",
            generationId: next.generationId,
            name: "replacement-agent",
          })
          expect(
            (yield* Effect.promise(() => acceptSession(newTokens.access_token)))
              .status,
          ).toBe(200)
          expect(
            (yield* Effect.promise(() => refresh(newTokens.refresh_token)))
              .status,
          ).toBe(200)
          const revoked = yield* Effect.promise(() =>
            change({
              operation: "revoke",
              id: next.id,
              generationId: next.generationId,
              expectedName: next.name,
            }),
          )
          expect(revoked.status).toBe(200)
          yield* verify(newTokens.access_token, time)
          expect(
            (yield* Effect.promise(() => acceptSession(newTokens.access_token)))
              .status,
          ).toBe(401)
          expect(
            (yield* Effect.promise(() => exchange({ secret: next.secret })))
              .status,
          ).toBe(400)
          expect(
            (yield* Effect.promise(() => refresh(newTokens.refresh_token)))
              .status,
          ).not.toBe(200)
          expect(yield* sessions.check(newSession).pipe(Effect.isFailure)).toBe(
            true,
          )
          expect(
            (yield* Effect.promise(() =>
              change({
                operation: "replace",
                id: next.id,
                generationId: next.generationId,
                expectedName: next.name,
                name: next.name,
                lifetimeDays: 1,
              }),
            )).status,
          ).toBe(403)
          const history = yield* db.select().from(schema.delegationHistory)
          expect(
            history
              .filter((event) => event.delegationEvent === "login")
              .map((event) => event.secretGenerationId)
              .sort(),
          ).toEqual(["dsg-test", next.generationId].sort())
          expect(JSON.stringify(history)).not.toContain(secret)
          expect(JSON.stringify(history)).not.toContain(next.secret)
        }).pipe(Effect.provide(isolated), Effect.withClock(clock)),
      )
    })
  }

  for (const [name, layer, exchangeAvailable] of [
    ["isolated", isolated, true],
    ["availability is independent of session-service composition", base, false],
  ] as const) {
    it(`reports trusted live availability: ${name}`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { availability, db, exchange } = yield* setup
          const response = yield* Effect.promise(() => availability())
          expect(response.status).toBe(200)
          expect(response.headers.get("cache-control")).toBe("no-store")
          expect(yield* Effect.promise(() => response.json())).toEqual({
            secretLoginEnabled: true,
          })
          const denied = yield* Effect.promise(() => availability("invalid"))
          expect(denied.status).not.toBe(200)
          yield* db
            .update(schema.oauthProvider)
            .set({ providerConfig: { delegatedAccess: false } })
          const disabled = yield* Effect.promise(() => availability())
          expect(disabled.status).toBe(200)
          expect(yield* Effect.promise(() => disabled.json())).toEqual({
            secretLoginEnabled: false,
          })
          expect((yield* Effect.promise(() => exchange())).status).toBe(
            exchangeAvailable ? 200 : 403,
          )
        }).pipe(Effect.provide(layer)),
      )
    })
  }

  it("returns live trusted session facts and rejects owner authority loss", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange, acceptSession, ownerId, verify } = yield* setup
        const issued = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => issued.json()))
        const initial = (yield* verify(tokens.access_token)).properties
        yield* db
          .update(schema.delegation)
          .set({ delegationName: "renamed-agent" })
        const response = yield* Effect.promise(() =>
          acceptSession(tokens.access_token),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(yield* Effect.promise(() => response.json())).toEqual({
          session: {
            ...initial,
            delegation: { ...initial.delegation, name: "renamed-agent" },
          },
        })
        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: true })
          .where(eq(schema.providerUserRole.providerUserId, ownerId))
        const denied = yield* Effect.promise(() =>
          acceptSession(tokens.access_token),
        )
        expect(denied.status).toBe(401)
        expect(yield* Effect.promise(() => denied.json())).toEqual({
          error: "invalid_token",
        })
        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: false })
          .where(eq(schema.providerUserRole.providerUserId, ownerId))
        yield* db
          .update(schema.providerUser)
          .set({ _deleted: true })
          .where(eq(schema.providerUser.id, ownerId))
        expect(
          (yield* Effect.promise(() => acceptSession(tokens.access_token)))
            .status,
        ).toBe(401)
      }).pipe(Effect.provide(isolated)),
    )
  })

  it("verifies session signatures, issuer, audience, raw identity and capped expiry", async () => {
    const logs: string[] = []
    const logger = Logger.make((entry) =>
      logs.push(Logger.stringLogger.log(entry)),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const { exchange, acceptSession, verify, key } = yield* setup
        const issued = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => issued.json()))
        const properties = (yield* verify(tokens.access_token)).properties
        const sign = (
          props: unknown,
          issuer = "https://auth.example.com",
          audience = "frontend",
          exp = now / 1000 + 120,
          mode = "access",
        ) =>
          new SignJWT({ mode, type: "providerUser", properties: props })
            .setProtectedHeader({ alg: key.alg, kid: key.id })
            .setIssuer(issuer)
            .setAudience(audience)
            .setSubject("delegation:dlg-test:dsg-test")
            .setExpirationTime(exp)
            .sign(key.private)
        const invalidSignature = `${tokens.access_token.slice(0, tokens.access_token.lastIndexOf(".") + 1)}invalid-signature`
        const { delegation: _delegation, ...human } = properties
        const invalid = [
          invalidSignature,
          yield* Effect.promise(() =>
            sign(properties, "https://wrong.example.com"),
          ),
          yield* Effect.promise(() =>
            sign(properties, undefined, "wrong-audience"),
          ),
          yield* Effect.promise(() =>
            sign(properties, undefined, undefined, now / 1000 + 121),
          ),
          yield* Effect.promise(() =>
            sign(properties, undefined, undefined, undefined, "refresh"),
          ),
          yield* Effect.promise(() => sign(human)),
          yield* Effect.promise(() =>
            sign({ ...properties, delegation: null }),
          ),
        ]
        for (const token of invalid) {
          const response = yield* Effect.promise(() => acceptSession(token))
          expect(response.status).toBe(401)
          expect(response.headers.get("cache-control")).toBe("no-store")
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "invalid_token",
          })
          expect(logs.join("\n")).not.toContain(token)
        }
        expect(
          (yield* Effect.promise(() =>
            acceptSession(tokens.access_token, "invalid-client"),
          )).status,
        ).toBe(400)
        expect(
          (yield* Effect.promise(() => acceptSession("x".repeat(30_000))))
            .status,
        ).toBe(400)
      }).pipe(
        Effect.provide(isolated),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    )
  })

  it("rejects a validly signed session exactly at its absolute expiry", async () => {
    let time = now
    await Effect.runPromise(
      Effect.gen(function* () {
        const { exchange, acceptSession } = yield* setup
        const issued = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => issued.json()))
        time = now + 119_999
        expect(
          (yield* Effect.promise(() => acceptSession(tokens.access_token)))
            .status,
        ).toBe(200)
        time++
        const expired = yield* Effect.promise(() =>
          acceptSession(tokens.access_token),
        )
        expect(expired.status).toBe(401)
        expect(yield* Effect.promise(() => expired.json())).toEqual({
          error: "invalid_token",
        })
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
  it("fails closed on real storage failure without exposing credential-bearing causes", async () => {
    const logs: string[] = []
    const logger = Logger.make((entry) =>
      logs.push(Logger.stringLogger.log(entry)),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, secret, exchange } = yield* setup
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`CREATE TRIGGER fail_delegated_use BEFORE UPDATE ON pf_secret_generation
        BEGIN SELECT RAISE(ABORT, 'private verifier ${secret}'); END`)
        const response = yield* Effect.promise(() => exchange())
        expect(response.status).toBe(400)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: "invalid_grant",
        })
        expect(logs.join("\n")).not.toContain(secret)
        expect(logs.join("\n")).not.toContain("private verifier")
        expect(yield* db.select().from(schema.delegationHistory)).toHaveLength(
          0,
        )
      }).pipe(
        Effect.provide(isolated),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    )
  })
  it("exchanges a freshly issued secret and rejects delegated issuance without manufacturing human evidence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { server, key, owner, exchange, verify } = yield* setup
        const human = yield* Effect.promise(() =>
          new SignJWT({
            mode: "access",
            type: "providerUser",
            properties: {
              userId: owner.id,
              email: owner.email,
              orgUnitId: owner.orgUnitId,
              orgUnitPath: "/",
              roles: ["/Tester"],
              humanAuthentication: {
                providerUserId: owner.id,
                authenticatedAt: now,
                method: "passkey",
              },
            },
          })
            .setProtectedHeader({ alg: key.alg, kid: key.id })
            .setIssuer("https://auth.example.com")
            .setAudience("frontend")
            .setSubject(`providerUser:${owner.id}`)
            .setExpirationTime(now / 1000 + 3600)
            .sign(key.private),
        )
        const issue = (token: string) =>
          server.request("https://auth.example.com/delegations", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "issued-agent", lifetimeDays: 1 }),
          })
        const issued = yield* Effect.promise(() => issue(human))
        expect(issued.status).toBe(201)
        const metadata = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String,
            generationId: Schema.String,
            secret: Schema.String,
          }),
        )(yield* Effect.promise(() => issued.json()))
        const response = yield* Effect.promise(() =>
          exchange({ secret: metadata.secret }),
        )
        expect(response.status).toBe(200)
        const tokens = Tokens(yield* Effect.promise(() => response.json()))
        const session = (yield* verify(tokens.access_token)).properties
        expect(session.delegation?.generationId).toBe(metadata.generationId)
        expect(session.humanAuthentication).toBeUndefined()
        expect(
          (yield* Effect.promise(() => issue(tokens.access_token))).status,
        ).toBe(403)
        const service = yield* DelegationSessionService
        expect(
          Option.isNone(
            yield* service
              .check({
                ...session,
                humanAuthentication: {
                  providerUserId: owner.id,
                  authenticatedAt: now,
                  method: "passkey",
                },
              })
              .pipe(Effect.option),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(isolated)),
    )
  })

  it("keeps selected roles across ordinary refresh while unselected sessions follow role additions", async () => {
    let time = now
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, ownerId, exchange, refresh, verify } = yield* setup
        const issued = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => issued.json()))
        const initial = (yield* verify(tokens.access_token)).properties
        const service = yield* DelegationSessionService
        const [role] = yield* db
          .insert(schema.role)
          .values({
            name: "Added",
            path: "/Added",
            orgUnitId: initial.orgUnitId,
          })
          .returning()
        yield* db
          .insert(schema.providerUserRole)
          .values({ providerUserId: ownerId, roleId: role!.id })
        expect((yield* service.check(initial)).roles).toContain("/Added")
        const switched = yield* Effect.promise(() =>
          refresh(tokens.refresh_token, "role:%2FTester"),
        )
        const selected = Tokens(yield* Effect.promise(() => switched.json()))
        const selectedSession = (yield* verify(selected.access_token))
          .properties
        expect(selectedSession.delegationRoleSelection).toEqual(["/Tester"])
        expect((yield* service.check(selectedSession)).roles).toEqual([
          "/Tester",
        ])
        time += 60_000
        const refreshed = yield* Effect.promise(() =>
          refresh(selected.refresh_token, "cli role:%2FAdded"),
        )
        expect(refreshed.status).toBe(200)
        const rotated = Tokens(yield* Effect.promise(() => refreshed.json()))
        expect(rotated.refresh_expires_in).toBe(60)
        expect(
          (yield* verify(rotated.access_token, time)).properties.roles,
        ).toEqual(["/Tester"])
        expect((yield* verify(rotated.access_token, time)).expiresAt).toBe(
          now + 120_000,
        )
        const ordinary = yield* Effect.promise(() =>
          refresh(rotated.refresh_token),
        )
        expect(ordinary.status).toBe(200)
        const ordinaryTokens = Tokens(
          yield* Effect.promise(() => ordinary.json()),
        )
        expect(
          (yield* verify(ordinaryTokens.access_token, time)).properties,
        ).toEqual((yield* verify(rotated.access_token, time)).properties)
        time += 60_000
        expect(
          (yield* Effect.promise(() => refresh(rotated.refresh_token))).status,
        ).toBe(400)
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

  it("bounds public attempts and never records failed exchange as login", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange } = yield* setup
        for (let attempt = 0; attempt < 30; attempt++)
          expect(
            (yield* Effect.promise(() => exchange({ secret: "invalid" })))
              .status,
          ).toBe(400)
        expect((yield* Effect.promise(() => exchange())).status).toBe(429)
        expect(yield* db.select().from(schema.delegationHistory)).toHaveLength(
          0,
        )
      }).pipe(Effect.provide(isolated)),
    )
  })

  it("rejects removed and revoked generations at both accepting and refresh boundaries", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange, refresh, verify } = yield* setup
        const response = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => response.json()))
        const session = (yield* verify(tokens.access_token)).properties
        const service = yield* DelegationSessionService
        yield* db
          .update(schema.secretGeneration)
          .set({ secretRevokedAt: DateTime.unsafeMake(now) })
        expect(
          Option.isNone(yield* service.check(session).pipe(Effect.option)),
        ).toBe(true)
        expect(
          (yield* Effect.promise(() => refresh(tokens.refresh_token))).status,
        ).toBe(400)
        expect((yield* Effect.promise(() => exchange())).status).toBe(400)
        yield* db
          .update(schema.secretGeneration)
          .set({ secretRevokedAt: null, _deleted: true })
        expect(
          Option.isNone(yield* service.check(session).pipe(Effect.option)),
        ).toBe(true)
      }).pipe(Effect.provide(isolated)),
    )
  })
  it("fails exchange and session validation closed when the session service is missing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { exchange, acceptSession } = yield* setup
        expect((yield* Effect.promise(() => exchange())).status).toBe(403)
        const response = yield* Effect.promise(() =>
          acceptSession("unavailable"),
        )
        expect(response.status).toBe(403)
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: "delegated_access_unavailable",
        })
      }).pipe(Effect.provide(base)),
    )
  })

  it("exchanges verifier-only secrets, caps signed tokens and retains identity on both refresh paths", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange, refresh, verify } = yield* setup
        const response = yield* Effect.promise(() => exchange())
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe("no-store")
        const tokens = Tokens(yield* Effect.promise(() => response.json()))
        const verified = yield* verify(tokens.access_token)
        expect(verified.expiresAt).toBe(now + 120_000)
        expect(verified.properties.humanAuthentication).toBeUndefined()
        expect(verified.properties.delegation).toEqual({
          id: "dlg-test",
          generationId: "dsg-test",
          name: "agent",
          expiresAt: now + 120_000,
        })
        expect(tokens.refresh_expires_in).toBe(120)
        for (const scope of [undefined, "role:%2FTester", "cli"]) {
          const response = yield* Effect.promise(() =>
            refresh(tokens.refresh_token, scope),
          )
          expect(response.status).toBe(200)
          const next = Tokens(yield* Effect.promise(() => response.json()))
          const checked = yield* verify(next.access_token)
          expect(checked.properties.delegation).toEqual(
            verified.properties.delegation,
          )
          expect(checked.properties.humanAuthentication).toBeUndefined()
          expect(checked.expiresAt).toBe(now + 120_000)
        }
        for (const scope of [
          "cli email:other@example.com",
          "email:other@example.com",
          "role:%2FAdministrator",
          "role:%ZZ",
        ]) {
          expect(
            (yield* Effect.promise(() => refresh(tokens.refresh_token, scope)))
              .status,
          ).toBe(400)
        }
        const history = yield* db.select().from(schema.delegationHistory)
        expect(history.map((row) => row.delegationEvent)).toEqual(["login"])
        expect(history[0]!.secretGenerationId).toBe("dsg-test")
        const generations = yield* db.select().from(schema.secretGeneration)
        expect(generations[0]!.secretLastUsedAt).not.toBeNull()
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

  it("rejects unknown, malformed, wrong-channel and extra-field secrets without sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, exchange, secret } = yield* setup
        for (const body of [
          { secret: `pfds_${"b".repeat(43)}` },
          { secret: "bad" },
          { secret, email: "owner@example.com" },
        ]) {
          expect((yield* Effect.promise(() => exchange(body))).status).toBe(400)
        }
        expect(
          (yield* Effect.promise(() => exchange({ secret }, "bad"))).status,
        ).toBe(400)
        expect(
          (yield* Effect.promise(() =>
            exchange({ secret }, undefined, "?secret=bad"),
          )).status,
        ).toBe(400)
        expect(yield* db.select().from(schema.delegationHistory)).toHaveLength(
          0,
        )
      }).pipe(Effect.provide(isolated)),
    )
  })

  it("checks live roles, owner, revocation, disable and exact absolute expiry", async () => {
    let time = now
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, store, exchange, refresh, verify, ownerId } = yield* setup
        const response = yield* Effect.promise(() => exchange())
        const tokens = Tokens(yield* Effect.promise(() => response.json()))
        const session = (yield* verify(tokens.access_token)).properties
        const live = yield* DelegationSessionService
        expect((yield* live.check(session)).roles).toContain("/Tester")
        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: true })
          .where(eq(schema.providerUserRole.providerUserId, ownerId))
        expect(
          Option.isNone(yield* live.check(session).pipe(Effect.option)),
        ).toBe(true)
        yield* db
          .update(schema.providerUserRole)
          .set({ _deleted: false })
          .where(eq(schema.providerUserRole.providerUserId, ownerId))
        time = now + 120_000 - 1
        expect((yield* live.check(session)).delegation.expiresAt).toBe(
          now + 120_000,
        )
        time++
        expect(
          Option.isNone(yield* live.check(session).pipe(Effect.option)),
        ).toBe(true)
        expect(
          (yield* Effect.promise(() => refresh(tokens.refresh_token))).status,
        ).toBe(400)
        expect(
          Option.isNone(
            yield* verify(tokens.access_token, time).pipe(Effect.option),
          ),
        ).toBe(true)
        time = now
        yield* db
          .update(schema.providerUser)
          .set({ _deleted: true })
          .where(eq(schema.providerUser.id, ownerId))
        expect(
          Option.isNone(yield* live.check(session).pipe(Effect.option)),
        ).toBe(true)
        yield* db
          .update(schema.providerUser)
          .set({ _deleted: false })
          .where(eq(schema.providerUser.id, ownerId))
        yield* db
          .update(schema.oauthProvider)
          .set({ providerConfig: { delegatedAccess: false } })
        expect((yield* live.check(session)).delegation).toEqual(
          session.delegation,
        )
        yield* db
          .update(schema.oauthProvider)
          .set({ providerConfig: { delegatedAccess: true } })
        expect((yield* live.check(session)).delegation).toEqual(
          session.delegation,
        )
        yield* store.revokeGeneration({
          generationId: session.delegation.generationId,
          revokedAt: DateTime.unsafeMake(time),
        })
        expect(
          Option.isNone(yield* live.check(session).pipe(Effect.option)),
        ).toBe(true)
        expect((yield* Effect.promise(() => exchange())).status).toBe(400)
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
})
