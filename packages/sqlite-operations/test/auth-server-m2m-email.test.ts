import { DateTime, Effect } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import { type ProviderUserSession, subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

describe("auth-server M2M email authentication", () => {
  it("should return employee token when email scope provided via M2M", async () => {
    const secretHash = await Bun.password.hash("e2e-secret")
    const testEmail = "employee@example.com"

    await Effect.runPromise(
      Effect.provide(
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

          if (!rootOrgUnit) throw new Error("Failed to create org unit")

          const [testerRole] = yield* db
            .insert(schema.role)
            .values({
              name: "Tester",
              orgUnitId: rootOrgUnit.id,
              path: "/Tester",
            })
            .returning()

          if (!testerRole) throw new Error("Failed to create role")

          const now = yield* DateTime.now
          const [user] = yield* db
            .insert(schema.user)
            .values({
              provider: "google",
              sub: "google-sub-123",
              lastLoggedIn: now,
            })
            .returning()

          if (!user) throw new Error("Failed to create user")

          const [providerUser] = yield* db
            .insert(schema.providerUser)
            .values({
              userId: user.id,
              email: testEmail,
              name: "Test Employee",
              firstName: "Test",
              lastName: "Employee",
              picture: "",
              locale: "en",
              orgUnitId: rootOrgUnit.id,
            })
            .returning()

          if (!providerUser) throw new Error("Failed to create provider user")

          yield* db.insert(schema.providerUserRole).values({
            providerUserId: providerUser.id,
            roleId: testerRole.id,
          })

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId: "e2e-client",
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          yield* db.insert(schema.permittedClientEmail).values({
            oauthClientId: oauthClient.id,
            email: testEmail,
          })

          const { app: issuerApp, runtime } = yield* createAuthenticationServer(
            {
              dummyConfig: {},
              clients: [
                {
                  id: "e2e-client",
                  redirectUris: [],
                  secretHash,
                },
              ],
            },
          )
          const auth = createTestApp(issuerApp, { runtime })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "e2e-client",
            fetch: (a, b) => Promise.resolve(auth.request(a, b)),
          })

          const basic = Buffer.from("e2e-client:e2e-secret").toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `email:${encodeURIComponent(testEmail)}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(200)
          const tokens = (yield* Effect.promise(() => response.json())) as {
            access_token: string
          }
          expect(tokens.access_token).toBeDefined()

          const verified = yield* Effect.promise(() =>
            client.verify(subjects, tokens.access_token),
          )
          if (verified.err) throw verified.err

          expect(verified.subject.type).toBe("providerUser")
          const props = verified.subject.properties as ProviderUserSession

          expect(props.email).toBe(testEmail)
          expect(props.orgUnitId).toBe(rootOrgUnit.id)
          expect(props.orgUnitPath).toBe("/")
          expect(props.roles).toContain("/Tester")
        }),
        TestLayer,
      ),
    )
  })

  it("should return invalid_scope for non-existent employee email via M2M", async () => {
    const secretHash = await Bun.password.hash("e2e-secret")

    await Effect.runPromise(
      Effect.provide(
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

          if (!rootOrgUnit) throw new Error("Failed to create org unit")

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId: "e2e-client",
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          yield* db.insert(schema.permittedClientEmail).values({
            oauthClientId: oauthClient.id,
            email: "nonexistent@example.com",
          })

          const { app: issuerApp2, runtime: runtime2 } =
            yield* createAuthenticationServer({
              dummyConfig: {},
              clients: [
                {
                  id: "e2e-client",
                  redirectUris: [],
                  secretHash,
                },
              ],
            })
          const auth2 = createTestApp(issuerApp2, { runtime: runtime2 })

          const basic = Buffer.from("e2e-client:e2e-secret").toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth2.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `email:${encodeURIComponent("nonexistent@example.com")}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(400)
          const error = (yield* Effect.promise(() => response.json())) as {
            error: string
            error_description: string
          }
          expect(error.error).toBe("invalid_scope")
          expect(error.error_description).toContain("Provider user not found")
        }),
        TestLayer,
      ),
    )
  })

  it("should use employee default roles when no role scope provided via M2M", async () => {
    const secretHash = await Bun.password.hash("e2e-secret")
    const testEmail = "employee@example.com"
    const clientId = "e2e-client-default"

    await Effect.runPromise(
      Effect.provide(
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

          if (!rootOrgUnit) throw new Error("Failed to create org unit")

          const [role1] = yield* db
            .insert(schema.role)
            .values({
              name: "Manager",
              orgUnitId: rootOrgUnit.id,
              path: "/Manager",
            })
            .returning()
          const [role2] = yield* db
            .insert(schema.role)
            .values({
              name: "Developer",
              orgUnitId: rootOrgUnit.id,
              path: "/Developer",
            })
            .returning()

          if (!role1 || !role2) throw new Error("Failed to create roles")

          const now = yield* DateTime.now
          const [user] = yield* db
            .insert(schema.user)
            .values({
              provider: "google",
              sub: "google-sub-roles",
              lastLoggedIn: now,
            })
            .returning()

          if (!user) throw new Error("Failed to create user")

          const [providerUser] = yield* db
            .insert(schema.providerUser)
            .values({
              userId: user.id,
              email: testEmail,
              name: "Test Employee",
              firstName: "Test",
              lastName: "Employee",
              picture: "",
              locale: "en",
              orgUnitId: rootOrgUnit.id,
            })
            .returning()

          if (!providerUser) throw new Error("Failed to create provider user")

          yield* db.insert(schema.providerUserRole).values([
            { providerUserId: providerUser.id, roleId: role1.id },
            { providerUserId: providerUser.id, roleId: role2.id },
          ])

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId,
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          yield* db.insert(schema.permittedClientEmail).values({
            oauthClientId: oauthClient.id,
            email: testEmail,
          })

          const { app: issuerApp3, runtime: runtime3 } =
            yield* createAuthenticationServer({
              dummyConfig: {},
              clients: [
                {
                  id: clientId,
                  redirectUris: [],
                  secretHash,
                },
              ],
            })
          const auth3 = createTestApp(issuerApp3, { runtime: runtime3 })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: clientId,
            fetch: (a, b) => Promise.resolve(auth3.request(a, b)),
          })

          const basic = Buffer.from(`${clientId}:e2e-secret`).toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth3.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `email:${encodeURIComponent(testEmail)}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(200)
          const tokens = (yield* Effect.promise(() => response.json())) as {
            access_token: string
          }

          const verified = yield* Effect.promise(() =>
            client.verify(subjects, tokens.access_token),
          )
          if (verified.err) throw verified.err

          const props = verified.subject.properties as ProviderUserSession

          expect(props.roles).toContain("/Manager")
          expect(props.roles).toContain("/Developer")
          expect(props.roles.length).toBe(2)
        }),
        TestLayer,
      ),
    )
  })

  it("should ignore role scopes when provided with email scope via M2M", async () => {
    const secretHash = await Bun.password.hash("e2e-secret")
    const testEmail = "employee@example.com"

    await Effect.runPromise(
      Effect.provide(
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

          if (!rootOrgUnit) throw new Error("Failed to create org unit")

          const [validRole] = yield* db
            .insert(schema.role)
            .values({
              name: "ValidRole",
              orgUnitId: rootOrgUnit.id,
              path: "/ValidRole",
            })
            .returning()

          if (!validRole) throw new Error("Failed to create valid role")

          const now = yield* DateTime.now
          const [user] = yield* db
            .insert(schema.user)
            .values({
              provider: "google",
              sub: "google-sub-validate",
              lastLoggedIn: now,
            })
            .returning()

          if (!user) throw new Error("Failed to create user")

          const [providerUser] = yield* db
            .insert(schema.providerUser)
            .values({
              userId: user.id,
              email: testEmail,
              name: "Test Employee",
              firstName: "Test",
              lastName: "Employee",
              picture: "",
              locale: "en",
              orgUnitId: rootOrgUnit.id,
            })
            .returning()

          if (!providerUser) throw new Error("Failed to create provider user")

          yield* db.insert(schema.providerUserRole).values({
            providerUserId: providerUser.id,
            roleId: validRole.id,
          })

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId: "e2e-client",
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          yield* db.insert(schema.permittedClientEmail).values({
            oauthClientId: oauthClient.id,
            email: testEmail,
          })

          const { app: issuerApp4, runtime: runtime4 } =
            yield* createAuthenticationServer({
              dummyConfig: {},
              clients: [
                {
                  id: "e2e-client",
                  redirectUris: [],
                  secretHash,
                },
              ],
            })
          const auth4 = createTestApp(issuerApp4, { runtime: runtime4 })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "e2e-client",
            fetch: (a, b) => Promise.resolve(auth4.request(a, b)),
          })

          const basic = Buffer.from("e2e-client:e2e-secret").toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth4.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `email:${encodeURIComponent(testEmail)} role:${encodeURIComponent("/InvalidRole")}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(200)
          const tokens = (yield* Effect.promise(() => response.json())) as {
            access_token: string
          }

          const verified = yield* Effect.promise(() =>
            client.verify(subjects, tokens.access_token),
          )
          if (verified.err) throw verified.err

          const props = verified.subject.properties as ProviderUserSession
          expect(props.roles).toContain("/ValidRole")
          expect(props.roles).not.toContain("/InvalidRole")
        }),
        TestLayer,
      ),
    )
  })
})
