import { readFileSync } from "node:fs"
import { NodeFileSystem } from "@effect/platform-node"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, ManagedRuntime } from "effect"
import { createSchema, createYoga } from "graphql-yoga"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import * as dbSchema from "@pf/drizzle-sqlite"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { authenticateProviderUserByPasskey } from "../../../../packages/auth-api/src/lib/passkey-auth"
import { transformSchemaWithAuthDirective } from "../../../../packages/graphql-api/src/lib/auth-directive-plugin"
import { createResolverExecutor } from "../../../../packages/graphql-api/src/lib/resolver-utils"
import { systemSchema } from "../../../../packages/graphql-api/src/lib/system-resolvers"
import type { UserContext } from "../../../../packages/graphql-api/src/lib/types"
import { expect, test } from "bun:test"

// Real GraphQL/Cedar/SQLite owns eligibility, optional-input compatibility and
// transaction rollback. UI tests cannot detect a direct-mutation bypass.
test("administrator name updates preserve identity ownership and atomically persist names and roles", async () => {
  let requestTime = DateTime.makeUnsafe("2026-11-12T10:00:00Z")
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.merge(
        SqliteGraphqlDbOperationsLive,
        SqliteAuthenticationDatabaseLive,
      ).pipe(Layer.provideMerge(DatabaseTest)),
      LocalCedarAuthorizationLive.pipe(
        Layer.provide(
          Layer.succeed(LocalCedarConfig, {
            schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
            policiesText: [
              readFileSync(getDefaultPoliciesPath(), "utf8"),
              'permit(principal, action == PF::Action::"administerUsers", resource);',
              'forbid(principal == PF::ProviderUser::"denied@example.com", action == PF::Action::"administerUsers", resource);',
            ],
          }),
        ),
      ),
    ),
  )
  try {
    const ids = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const [unit] = yield* db
          .insert(dbSchema.orgUnit)
          .values({ name: "Root", orgUnitLevel: "root", path: "/" })
          .returning()
        const [role] = yield* db
          .insert(dbSchema.role)
          .values({ name: "Tester", path: "/Tester", orgUnitId: unit!.id })
          .returning()
        const accounts = []
        for (const provider of ["passkey", "google"]) {
          const email = `${provider}@example.com`
          const [user] = yield* db
            .insert(dbSchema.user)
            .values({ provider, sub: email, createdAt: requestTime })
            .returning()
          const [profile] = yield* db
            .insert(dbSchema.providerUser)
            .values({
              userId: user!.id,
              email,
              name: email,
              firstName: "",
              lastName: "",
              picture: "",
              locale: "en",
              orgUnitId: unit!.id,
            })
            .returning()
          // An SSO-origin identity with a credential remains externally owned.
          yield* db.insert(dbSchema.passkeyCredential).values({
            userId: user!.id,
            passkeyCredentialId: provider,
            passkeyPublicKey: "fixture",
            signatureCounter: "0",
          })
          accounts.push({ userId: user!.id, profileId: profile!.id, email })
        }
        return { passkey: accounts[0]!, google: accounts[1]!, role: role!.id }
      }),
    )
    const system = await runtime.runPromise(systemSchema)
    const schema = transformSchemaWithAuthDirective(
      createSchema<UserContext>({
        typeDefs: [
          readFileSync(
            new URL(
              "../../../../packages/graphql-schema/graphql/rxdb.graphql",
              import.meta.url,
            ),
            "utf8",
          ),
          system.typeDefs,
        ],
        resolvers: system.resolvers,
      }),
      createResolverExecutor(runtime),
    )
    const yoga = createYoga({
      schema,
      logging: false,
      context: ({ request }): UserContext => {
        requestTime = DateTime.makeUnsafe(
          DateTime.toEpochMillis(requestTime) + 10,
        )
        const email = request.headers.get("x-actor") ?? "admin@example.com"
        return {
          userId: email,
          _requestTime: requestTime,
          _userDetails: { id: email, by: email },
          jwt: {
            mode: "access",
            type: "user",
            properties: {
              userId: email,
              email,
              roles: ["/Administrator"],
              orgUnitId: "/",
              orgUnitPath: "/",
            },
            aud: "graphql-api",
            iss: "test",
            sub: email,
            exp: 0,
            iat: 0,
          },
        }
      },
    })
    const execute = async (
      query: string,
      variables: Record<string, unknown>,
      actor = "admin@example.com",
    ) => {
      const response = await yoga.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-actor": actor },
          body: JSON.stringify({ query, variables }),
        }),
      )
      return response.json()
    }
    const mutation = `mutation Save($id: ID!, $input: UpdateProviderUserInput!) {
      updateProviderUser(providerUserId: $id, input: $input) {
        __typename ... on UpdateProviderUserFailure { error }
        ... on UpdateProviderUserSuccess { providerUser { firstName lastName name roleIds } }
      }
    }`
    const save = (
      input: Record<string, unknown>,
      id = ids.passkey.profileId,
      actor?: string,
    ) => execute(mutation, { id, input }, actor)
    const read = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const [profile] = yield* db
            .select()
            .from(dbSchema.providerUser)
            .where(eq(dbSchema.providerUser.id, ids.passkey.profileId))
          const roles = yield* db
            .select()
            .from(dbSchema.providerUserRole)
            .where(
              eq(
                dbSchema.providerUserRole.providerUserId,
                ids.passkey.profileId,
              ),
            )
          return { profile, roles: roles.map((r) => r.roleId) }
        }),
      )

    for (const [input, expected] of [
      [
        { firstName: "  Ada ", lastName: " Lovelace  " },
        { firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace" },
      ],
      [{}, { firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace" }],
      [
        { firstName: " " },
        { firstName: "", lastName: "Lovelace", name: "Lovelace" },
      ],
      [
        { firstName: "Grace", lastName: "" },
        { firstName: "Grace", lastName: "", name: "Grace" },
      ],
      [
        { firstName: "", lastName: "  " },
        { firstName: "", lastName: "", name: ids.passkey.email },
      ],
    ] as const) {
      const result = await save({ roleIds: [ids.role], ...input })
      expect(result.errors).toBeUndefined()
      expect(result.data.updateProviderUser).toMatchObject({
        __typename: "UpdateProviderUserSuccess",
        providerUser: expected,
      })
      expect(await read()).toMatchObject({
        profile: { ...expected, updatedBy: "admin@example.com" },
        roles: [ids.role],
      })
      if (expected.name === "Ada Lovelace") {
        const signedIn = await runtime.runPromise(
          authenticateProviderUserByPasskey({
            type: "authentication",
            email: ids.passkey.email,
            userHandle: ids.passkey.email,
            credentialId: "passkey",
            previousCounter: 0,
            newCounter: 0,
          }),
        )
        expect(signedIn).toMatchObject({
          id: ids.passkey.userId,
          roles: ["/Tester"],
        })
        expect((await read()).profile).toMatchObject(expected)
      }
    }
    const persisted = await read()
    // SQLite Julian-day storage rounds at the millisecond boundary.
    expect(
      Math.abs(
        DateTime.toEpochMillis(persisted.profile!.updatedAt) -
          DateTime.toEpochMillis(requestTime),
      ),
    ).toBeLessThanOrEqual(1)
    const independent = await execute(
      `query($id: ID!) { userDetail(userId: $id) { provider sub providerUser { name firstName lastName email } } }`,
      { id: ids.passkey.userId },
    )
    expect(independent.errors).toBeUndefined()
    expect(independent.data.userDetail).toMatchObject({
      provider: "passkey",
      sub: ids.passkey.email,
      providerUser: {
        name: ids.passkey.email,
        firstName: "",
        lastName: "",
        email: ids.passkey.email,
      },
    })

    const denied = await save(
      { roleIds: [], firstName: "Forbidden" },
      ids.passkey.profileId,
      "denied@example.com",
    )
    expect(denied.errors?.length).toBeGreaterThan(0)
    expect(await read()).toEqual(persisted)
    const sso = await save(
      { roleIds: [], firstName: "Not local" },
      ids.google.profileId,
    )
    expect(sso.data.updateProviderUser).toMatchObject({
      __typename: "UpdateProviderUserFailure",
      error: expect.stringContaining("external identity provider"),
    })
    const external = await execute(
      `query($id: ID!) { userDetail(userId: $id) { provider sub providerUser { email name firstName lastName roleIds } } }`,
      { id: ids.google.userId },
    )
    expect(external.errors).toBeUndefined()
    expect(external.data.userDetail).toMatchObject({
      provider: "google",
      sub: ids.google.email,
      providerUser: {
        email: ids.google.email,
        name: ids.google.email,
        firstName: "",
        lastName: "",
        roleIds: [],
      },
    })
    expect(
      (await save({ roleIds: [] }, ids.google.profileId)).data
        .updateProviderUser.__typename,
    ).toBe("UpdateProviderUserSuccess")

    for (const input of [
      { roleIds: ["missing"], firstName: "Invalid role" },
      { roleIds: [], firstName: "x".repeat(129) },
      // Duplicate valid role IDs fail at insertion, after the profile write and
      // old-role deletion. This proves actual transaction rollback.
      { roleIds: [ids.role, ids.role], firstName: "Rollback" },
    ]) {
      const result = await save(input)
      expect(result.data.updateProviderUser.__typename).toBe(
        "UpdateProviderUserFailure",
      )
      expect(await read()).toEqual(persisted)
    }
    for (const field of ["email", "provider", "sub"]) {
      expect(
        (await save({ roleIds: [], [field]: "changed" })).errors?.length,
      ).toBeGreaterThan(0)
      expect(await read()).toEqual(persisted)
    }
  } finally {
    await runtime.dispose()
  }
})
