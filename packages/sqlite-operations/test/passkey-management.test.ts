import { eq } from "drizzle-orm"
import { DateTime, Effect, Either, Layer } from "effect"
import { SignJWT } from "jose"
import {
  AuthenticationDatabase,
  authenticateProviderUserByPasskey,
  createAuthenticationServer,
  getPasskeyUserHandle,
  registerAdditionalPasskeyForAccount,
} from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { InvitationLifecycleStatus } from "@pf/graphql-db-operations"
import {
  KeyManagementService,
  KeyManagementServiceLive,
  createTestApp,
} from "@pf/openauth"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

const layer = Layer.mergeAll(
  TestLayer,
  KeyManagementServiceLive.pipe(Layer.provide(TestLayer)),
)

const listed = (input: unknown) => {
  const body = input as {
    organisation: { name: string }
    account: { userId: string; email: string }
    credentials: Array<{
      id: string
      name: string | null
      createdAt: string
      lastUsedAt: string | null
    }>
  }
  expect(body.organisation.name).toBe("Root Organization")
  return body
}

const setup = (
  options: {
    provider?: string
    withPasskey?: boolean
    passkeysEnabled?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const provider = options.provider ?? "passkey"
    const withPasskey = options.withPasskey ?? true
    const passkeysEnabled = options.passkeysEnabled ?? true
    const { rootOrgUnitId, testerRoleId, invitationId } =
      yield* setupTestData("owner@example.com")
    const db = yield* TypedSqliteDrizzle
    const authDb = yield* AuthenticationDatabase
    const owner = yield* authDb.createProviderUser({
      email: "owner@example.com",
      name: "Owner",
      firstName: "Owner",
      lastName: "",
      picture: "",
      locale: "en",
      provider,
      sub: "owner",
      orgUnitId: rootOrgUnitId,
    })
    yield* authDb.assignProviderUserRoles(owner.id, [testerRoleId])
    yield* authDb.acceptPendingInvitationForUser({
      email: owner.email,
      userId: owner.id,
      provider,
      subject: owner.sub,
      acceptedAt: yield* DateTime.now,
    })
    if (passkeysEnabled) {
      yield* db.insert(schema.oauthProvider).values({
        providerName: "passkey",
        providerConfig: {
          rpName: "Test",
          rpID: "auth.example.com",
          origin: "https://auth.example.com",
        },
      })
    }
    if (withPasskey) {
      yield* authDb.createPasskeyCredential({
        userId: owner.id,
        credentialId: "credential-one",
        publicKey: "public-key-one",
        counter: 0,
        transports: ["internal", "hybrid"],
      })
    }
    const { app, runtime } = yield* createAuthenticationServer({
      clients: [
        { id: "frontend", redirectUris: ["https://app.example.com/callback"] },
      ],
    })
    const server = createTestApp(app, { runtime })
    const key = yield* (yield* KeyManagementService).signingKey
    const clock = yield* Effect.clock
    const sign = (
      properties: Record<string, unknown>,
      extra: { type?: string } = {},
    ) =>
      new SignJWT({
        mode: "access",
        type: extra.type ?? "providerUser",
        properties,
      })
        .setProtectedHeader({ alg: key.alg, kid: key.id })
        .setIssuer("https://auth.example.com")
        .setAudience("frontend")
        .setSubject(`providerUser:${owner.id}`)
        .setIssuedAt(Math.floor(clock.unsafeCurrentTimeMillis() / 1000))
        .setExpirationTime(
          Math.floor(clock.unsafeCurrentTimeMillis() / 1000) + 3600,
        )
        .sign(key.private)
    const properties = {
      humanSession: true as const,
      userId: owner.id,
      email: owner.email,
      orgUnitId: rootOrgUnitId,
      orgUnitPath: "/",
      roles: ["/Tester"],
    }
    const token = yield* Effect.promise(() => sign(properties))
    const request = (
      method: string,
      bearer = token,
      body?: unknown,
      ownerUserId?: string,
    ) =>
      server.request(
        `https://auth.example.com/passkeys${ownerUserId === undefined ? "" : `?ownerUserId=${encodeURIComponent(ownerUserId)}`}`,
        {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      )
    return {
      db,
      authDb,
      owner,
      invitationId,
      testerRoleId,
      properties,
      sign,
      token,
      request,
    }
  })

describe("Passkey management HTTP + SQLite", () => {
  it("lists unnamed credentials and persists a rename for a human session", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, db, owner, invitationId } = yield* setup()
        const listedResponse = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        expect(listedResponse.account).toEqual({
          userId: owner.id,
          email: "owner@example.com",
        })
        expect(listedResponse.credentials).toHaveLength(1)
        expect(listedResponse.credentials[0]?.name).toBeNull()
        expect(listedResponse.credentials[0]?.lastUsedAt).toBeNull()
        expect(
          Number.isFinite(
            Date.parse(listedResponse.credentials[0]?.createdAt ?? ""),
          ),
        ).toBe(true)

        const credentialId = listedResponse.credentials[0]?.id
        expect(credentialId).toBeDefined()
        const renamed = yield* Effect.promise(() =>
          request("PATCH", undefined, {
            id: credentialId,
            name: "Laptop key",
          }),
        )
        expect(renamed.status).toBe(200)
        const after = listed(yield* Effect.promise(() => renamed.json()))
        expect(after.credentials[0]?.name).toBe("Laptop key")

        const duplicate = yield* Effect.promise(() =>
          request("PATCH", undefined, {
            id: credentialId,
            name: "Laptop key",
          }),
        )
        expect(duplicate.status).toBe(200)

        const stored = yield* db
          .select()
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, owner.id))
        expect(stored[0]?.passkeyName).toBe("Laptop key")
        expect(stored[0]?.passkeyCredentialId).toBe("credential-one")
        expect(stored[0]?.passkeyPublicKey).toBe("public-key-one")

        const user = yield* db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, owner.id))
        expect(user[0]?.provider).toBe("passkey")
        const roles = yield* db
          .select()
          .from(schema.providerUserRole)
          .innerJoin(
            schema.providerUser,
            eq(schema.providerUserRole.providerUserId, schema.providerUser.id),
          )
          .where(eq(schema.providerUser.userId, owner.id))
        expect(roles).toHaveLength(1)
        const invitation = yield* db
          .select()
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitationId))
        expect(invitation[0]?.invitationStatus).toBe(
          InvitationLifecycleStatus.Accepted,
        )
      }).pipe(Effect.provide(layer)),
    )
  })

  it("allows duplicate names and rejects blank names", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, authDb, owner } = yield* setup()
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-two",
          publicKey: "public-key-two",
          counter: 0,
          name: "Spare key",
        })
        const listedResponse = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        const unnamed = listedResponse.credentials.find(
          (item) => item.name === null,
        )
        expect(listedResponse.credentials).toHaveLength(2)
        expect(unnamed).toBeDefined()
        expect(
          listedResponse.credentials.some((item) => item.name === "Spare key"),
        ).toBe(true)
        const blank = yield* Effect.promise(() =>
          request("PATCH", undefined, { id: unnamed?.id, name: "   " }),
        )
        expect(blank.status).toBe(400)
        expect(yield* Effect.promise(() => blank.json())).toEqual({
          error: "invalid_request",
        })
        const renamed = yield* Effect.promise(() =>
          request("PATCH", undefined, {
            id: unnamed?.id,
            name: "Spare key",
          }),
        )
        expect(renamed.status).toBe(200)
        expect(
          new Set(
            listed(yield* Effect.promise(() => renamed.json())).credentials.map(
              (item) => item.name,
            ),
          ),
        ).toEqual(new Set(["Spare key"]))
      }).pipe(Effect.provide(layer)),
    )
  })

  it("admits an OAuth-backed account that already owns a Passkey", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request } = yield* setup({ provider: "google" })
        const response = yield* Effect.promise(() => request("GET"))
        expect(response.status).toBe(200)
        expect(
          listed(yield* Effect.promise(() => response.json())).account.email,
        ).toBe("owner@example.com")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("denies accounts with no Passkey", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const withoutCredential = yield* setup({ withPasskey: false })
        const missing = yield* Effect.promise(() =>
          withoutCredential.request("GET"),
        )
        expect(missing.status).toBe(403)
        expect(yield* Effect.promise(() => missing.json())).toEqual({
          error: "management_denied",
        })
      }).pipe(Effect.provide(layer)),
    )
  })

  it("denies management when passkeys are not enabled", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const disabled = yield* setup({ passkeysEnabled: false })
        const gated = yield* Effect.promise(() => disabled.request("GET"))
        expect(gated.status).toBe(403)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not consult authentication age for a valid human session", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, sign, properties, owner } = yield* setup()
        const stale = yield* Effect.promise(() =>
          sign({
            ...properties,
            humanAuthentication: {
              providerUserId: owner.id,
              authenticatedAt: Date.parse("2020-01-01T00:00:00.000Z"),
              method: "passkey",
            },
          }),
        )
        const response = yield* Effect.promise(() => request("GET", stale))
        expect(response.status).toBe(200)
        const { humanSession: _ignored, ...withoutMarker } = properties
        const legacy = yield* Effect.promise(() =>
          sign({
            ...withoutMarker,
            humanAuthentication: {
              providerUserId: owner.id,
              authenticatedAt: Date.parse("2020-01-01T00:00:00.000Z"),
              method: "passkey",
            },
          }),
        )
        expect(
          (yield* Effect.promise(() => request("GET", legacy))).status,
        ).toBe(200)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rejects unauthenticated, machine, delegated, impersonation, and cross-owner requests", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, sign, properties, owner, authDb, db } = yield* setup()
        const unauthenticated = yield* Effect.promise(() => request("GET", ""))
        expect(unauthenticated.status).toBe(401)

        const machine = yield* Effect.promise(() =>
          sign(
            { userId: owner.id, clientId: "ci-pipeline", roles: [] },
            { type: "user" },
          ),
        )
        expect(
          (yield* Effect.promise(() => request("GET", machine))).status,
        ).toBe(401)

        const { humanSession: _ignored, ...withoutMarker } = properties
        const delegated = yield* Effect.promise(() =>
          sign({
            ...withoutMarker,
            delegation: {
              id: "delegate",
              generationId: "generation-1",
              name: "agent",
              expiresAt: Date.UTC(2030, 0, 1),
            },
          }),
        )
        expect(
          (yield* Effect.promise(() => request("GET", delegated))).status,
        ).toBe(403)

        const impersonated = yield* Effect.promise(() =>
          sign({
            userId: owner.id,
            email: owner.email,
            orgUnitId: properties.orgUnitId,
            orgUnitPath: "/",
            roles: ["/Tester"],
          }),
        )
        expect(
          (yield* Effect.promise(() => request("GET", impersonated))).status,
        ).toBe(403)

        const suppliedOwner = yield* Effect.promise(() =>
          request("GET", undefined, undefined, "someone-else"),
        )
        expect(suppliedOwner.status).toBe(400)

        const other = yield* authDb.createProviderUser({
          email: "other@example.com",
          name: "Other",
          firstName: "Other",
          lastName: "",
          picture: "",
          locale: "en",
          provider: "passkey",
          sub: "other",
          orgUnitId: properties.orgUnitId,
        })
        yield* authDb.createPasskeyCredential({
          userId: other.id,
          credentialId: "credential-other",
          publicKey: "public-key-other",
          counter: 0,
        })
        const otherRow = yield* db
          .select({ id: schema.passkeyCredential.id })
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, other.id))
        const cross = yield* Effect.promise(() =>
          request("PATCH", undefined, {
            id: otherRow[0]?.id,
            name: "Stolen",
          }),
        )
        expect(cross.status).toBe(403)
        const unchanged = yield* db
          .select()
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, other.id))
        expect(unchanged[0]?.passkeyName).toBeNull()
      }).pipe(Effect.provide(layer)),
    )
  })

  it("lists last-used only after the credential actually signed in", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, authDb, owner, db } = yield* setup()
        yield* authDb.createPasskeyCredential({
          userId: owner.id,
          credentialId: "credential-two",
          publicKey: "public-key-two",
          counter: 3,
        })
        const before = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        expect(before.credentials.map((item) => item.lastUsedAt)).toEqual([
          null,
          null,
        ])

        yield* authDb.updateLastLoggedIn(owner.id, yield* DateTime.now)
        const afterAccountLogin = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        expect(
          afterAccountLogin.credentials.map((item) => item.lastUsedAt),
        ).toEqual([null, null])

        const handle = getPasskeyUserHandle({
          provider: owner.provider,
          sub: owner.sub,
          userId: owner.id,
        })
        yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email: owner.email,
          userHandle: handle,
          credentialId: "credential-one",
          previousCounter: 0,
          newCounter: 0,
        })
        const afterFirst = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        const used = afterFirst.credentials.find(
          (item) => item.lastUsedAt !== null,
        )
        const unused = afterFirst.credentials.find(
          (item) => item.lastUsedAt === null,
        )
        expect(used?.lastUsedAt).toEqual(expect.any(String))
        expect(Number.isFinite(Date.parse(used?.lastUsedAt ?? ""))).toBe(true)
        expect(unused).toBeDefined()

        const stored = yield* db
          .select({
            id: schema.passkeyCredential.id,
            credentialId: schema.passkeyCredential.passkeyCredentialId,
          })
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, owner.id))
        const usedId = stored.find(
          (row) => row.credentialId === "credential-one",
        )?.id
        expect(used?.id).toBe(usedId)

        const renamed = listed(
          yield* Effect.promise(() =>
            request("PATCH", undefined, {
              id: usedId,
              name: "Laptop key",
            }).then((r) => r.json()),
          ),
        )
        expect(
          renamed.credentials.find((item) => item.id === usedId)?.lastUsedAt,
        ).toBe(used?.lastUsedAt)
        expect(
          renamed.credentials.find((item) => item.id === usedId)?.name,
        ).toBe("Laptop key")

        const failed = yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email: owner.email,
          userHandle: handle,
          credentialId: "credential-two",
          previousCounter: 3,
          newCounter: 3,
        }).pipe(Effect.either)
        expect(failed._tag).toBe("Left")
        const afterFailure = listed(
          yield* Effect.promise(() => request("GET").then((r) => r.json())),
        )
        expect(
          afterFailure.credentials.find((item) => item.id === unused?.id)
            ?.lastUsedAt,
        ).toBeNull()
        expect(
          afterFailure.credentials.find((item) => item.id === usedId)
            ?.lastUsedAt,
        ).toBe(used?.lastUsedAt)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("issues registration options bound to the account with excludeCredentials", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request } = yield* setup()
        const started = yield* Effect.promise(() =>
          request("POST", undefined, { name: "Spare key" }),
        )
        expect(started.status).toBe(200)
        const body = (yield* Effect.promise(() => started.json())) as {
          challengeId: string
          options: {
            authenticatorSelection?: {
              residentKey?: string
              requireResidentKey?: boolean
              userVerification?: string
            }
            excludeCredentials?: readonly {
              id: string
              type: string
              transports?: readonly string[]
            }[]
          }
        }
        expect(body.challengeId.length).toBeGreaterThan(0)
        expect(body.options.authenticatorSelection).toEqual({
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        })
        expect(body.options.excludeCredentials).toEqual([
          {
            id: "credential-one",
            type: "public-key",
            transports: ["internal", "hybrid"],
          },
        ])
        const blank = yield* Effect.promise(() =>
          request("POST", undefined, { name: "   " }),
        )
        expect(blank.status).toBe(400)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rejects failed verification without creating a credential", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, db, owner } = yield* setup()
        const started = yield* Effect.promise(() =>
          request("POST", undefined, { name: "Spare key" }),
        )
        const { challengeId } = (yield* Effect.promise(() =>
          started.json(),
        )) as { challengeId: string }
        const failed = yield* Effect.promise(() =>
          request("POST", undefined, {
            challengeId,
            response: {
              id: "forged",
              rawId: "forged",
              type: "public-key",
              authenticatorAttachment: "platform",
              clientExtensionResults: {},
              response: {
                clientDataJSON: "Zm9yZ2Vk",
                attestationObject: "Zm9yZ2Vk",
                transports: ["internal"],
                publicKeyAlgorithm: -7,
                publicKey: "AQID",
                authenticatorData: "Zm9yZ2Vk",
              },
            },
          }),
        )
        expect(failed.status).toBe(400)
        expect(yield* Effect.promise(() => failed.json())).toEqual({
          error: "verification_failed",
        })
        const stored = yield* db
          .select()
          .from(schema.passkeyCredential)
          .where(eq(schema.passkeyCredential.userId, owner.id))
        expect(stored).toHaveLength(1)
        expect(stored[0]?.passkeyCredentialId).toBe("credential-one")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("adds a named credential to the same account and authenticates with both", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { authDb, owner, db, invitationId } = yield* setup()
        const beforeInvitation = yield* db
          .select()
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitationId))
        const handle = getPasskeyUserHandle({
          ...owner,
          userId: owner.id,
        })
        const added = yield* registerAdditionalPasskeyForAccount({
          userId: owner.id,
          userHandle: handle,
          name: "Spare key",
          credential: {
            id: "credential-two",
            publicKey: "public-key-two",
            counter: 0,
            transports: ["internal"],
          },
        })
        expect(added.id).toBe(owner.id)
        expect(added.roles).toEqual(["/Tester"])
        expect(added.provider).toBe("passkey")
        const listed = yield* authDb.listPasskeyCredentialsForUser(owner.id)
        expect(listed).toHaveLength(2)
        expect(listed.some((item) => item.name === "Spare key")).toBe(true)
        const first = yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email: owner.email,
          userHandle: handle,
          credentialId: "credential-one",
          previousCounter: 0,
          newCounter: 0,
        })
        const second = yield* authenticateProviderUserByPasskey({
          type: "authentication",
          email: owner.email,
          userHandle: handle,
          credentialId: "credential-two",
          previousCounter: 0,
          newCounter: 0,
        })
        expect(first.id).toBe(owner.id)
        expect(second.id).toBe(owner.id)
        expect(first.roles).toEqual(["/Tester"])
        expect(second.roles).toEqual(["/Tester"])
        const afterInvitation = yield* db
          .select()
          .from(schema.invitation)
          .where(eq(schema.invitation.id, invitationId))
        expect(afterInvitation).toEqual(beforeInvitation)
        expect(afterInvitation[0]?.invitationStatus).toBe(
          InvitationLifecycleStatus.Accepted,
        )
        const roles = yield* db
          .select()
          .from(schema.providerUserRole)
          .innerJoin(
            schema.providerUser,
            eq(schema.providerUserRole.providerUserId, schema.providerUser.id),
          )
          .where(eq(schema.providerUser.userId, owner.id))
        expect(roles).toHaveLength(1)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("preserves an OAuth-backed account when adding a named Passkey", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { authDb, owner } = yield* setup({ provider: "google" })
        const handle = getPasskeyUserHandle({
          ...owner,
          userId: owner.id,
        })
        const added = yield* registerAdditionalPasskeyForAccount({
          userId: owner.id,
          userHandle: handle,
          name: "Hardware key",
          credential: {
            id: "credential-oauth-two",
            publicKey: "public-key-oauth-two",
            counter: 0,
          },
        })
        expect(added.id).toBe(owner.id)
        expect(added.provider).toBe("google")
        expect(
          (yield* authDb.listPasskeyCredentialsForUser(owner.id)).some(
            (item) => item.name === "Hardware key",
          ),
        ).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rejects duplicate credential persistence and allows a different credential", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { authDb, owner } = yield* setup()
        const handle = getPasskeyUserHandle({
          ...owner,
          userId: owner.id,
        })
        const duplicate = yield* registerAdditionalPasskeyForAccount({
          userId: owner.id,
          userHandle: handle,
          name: "Duplicate",
          credential: {
            id: "credential-one",
            publicKey: "other-key",
            counter: 0,
          },
        }).pipe(Effect.either)
        expect(Either.isLeft(duplicate)).toBe(true)
        if (Either.isLeft(duplicate)) {
          expect(duplicate.left._tag).toBe(
            "@pf/PasskeyCredentialAlreadyOwnedError",
          )
        }
        expect(
          yield* authDb.listPasskeyCredentialsForUser(owner.id),
        ).toHaveLength(1)
        const retry = yield* registerAdditionalPasskeyForAccount({
          userId: owner.id,
          userHandle: handle,
          name: "Spare key",
          credential: {
            id: "credential-retry",
            publicKey: "retry-key",
            counter: 0,
          },
        })
        expect(retry.id).toBe(owner.id)
        expect(
          yield* authDb.listPasskeyCredentialsForUser(owner.id),
        ).toHaveLength(2)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rejects enrollment from unauthenticated, delegated, and cross-owner sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, sign, properties, owner } = yield* setup()
        expect(
          (yield* Effect.promise(() =>
            request("POST", "", { name: "Spare key" }),
          )).status,
        ).toBe(401)
        const { humanSession: _ignored, ...withoutMarker } = properties
        const delegated = yield* Effect.promise(() =>
          sign({
            ...withoutMarker,
            delegation: {
              id: "delegate",
              generationId: "generation-1",
              name: "agent",
              expiresAt: Date.UTC(2030, 0, 1),
            },
          }),
        )
        expect(
          (yield* Effect.promise(() =>
            request("POST", delegated, { name: "Spare key" }),
          )).status,
        ).toBe(403)
        const machine = yield* Effect.promise(() =>
          sign(
            { userId: owner.id, clientId: "ci-pipeline", roles: [] },
            { type: "user" },
          ),
        )
        expect(
          (yield* Effect.promise(() =>
            request("POST", machine, { name: "Spare key" }),
          )).status,
        ).toBe(401)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not add a first Passkey through self-service enrollment", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const withoutCredential = yield* setup({ withPasskey: false })
        expect(
          (yield* Effect.promise(() =>
            withoutCredential.request("POST", undefined, {
              name: "First key",
            }),
          )).status,
        ).toBe(403)
        const denied = yield* registerAdditionalPasskeyForAccount({
          userId: withoutCredential.owner.id,
          userHandle: getPasskeyUserHandle({
            ...withoutCredential.owner,
            userId: withoutCredential.owner.id,
          }),
          name: "First key",
          credential: {
            id: "credential-first",
            publicKey: "public-key-first",
            counter: 0,
          },
        }).pipe(Effect.either)
        expect(Either.isLeft(denied)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not consult authentication age for enrollment", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { request, sign, properties, owner } = yield* setup()
        const stale = yield* Effect.promise(() =>
          sign({
            ...properties,
            humanAuthentication: {
              providerUserId: owner.id,
              authenticatedAt: Date.parse("2020-01-01T00:00:00.000Z"),
              method: "passkey",
            },
          }),
        )
        expect(
          (yield* Effect.promise(() =>
            request("POST", stale, { name: "Spare key" }),
          )).status,
        ).toBe(200)
      }).pipe(Effect.provide(layer)),
    )
  })
})
