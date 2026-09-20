import { DateTime, Effect } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import { type ServiceAccountSession, subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

describe("auth-server M2M role authentication", () => {
  it("should return 'user' subject type for M2M client_credentials authentication", async () => {
    const secretHash = await Bun.password.hash("ci-secret")

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

          const [ciRole] = yield* db
            .insert(schema.role)
            .values({
              name: "CI Runner",
              orgUnitId: rootOrgUnit.id,
              path: "/CI",
            })
            .returning()

          if (!ciRole) throw new Error("Failed to create role")

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId: "ci-client",
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          yield* db.insert(schema.permittedClientRole).values({
            oauthClientId: oauthClient.id,
            roleId: ciRole.id,
          })

          const { app: issuerApp, runtime } = yield* createAuthenticationServer(
            {
              dummyConfig: {},
              clients: [
                {
                  id: "ci-client",
                  redirectUris: [],
                  secretHash,
                },
              ],
            },
          )
          const auth = createTestApp(issuerApp, { runtime })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "ci-client",
            fetch: (a, b) => Promise.resolve(auth.request(a, b)),
          })

          const basic = Buffer.from("ci-client:ci-secret").toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `role:${encodeURIComponent("/CI")}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(200)
          const tokens = (yield* Effect.promise(() => response.json())) as {
            access_token: string
            refresh_token?: string
          }
          expect(tokens.access_token).toBeDefined()
          expect(tokens.refresh_token).toBeUndefined()

          const verified = yield* Effect.promise(() =>
            client.verify(subjects, tokens.access_token),
          )
          if (verified.err) throw verified.err

          expect(verified.subject.type).toBe("user")
          const props = verified.subject.properties as ServiceAccountSession

          expect(props.userId).toBeDefined()
          expect(props.roles).toContain("/CI")
          expect(props.orgUnitId).toBe(rootOrgUnit.id)
          expect(props.orgUnitPath).toBe("/")
        }),
        TestLayer,
      ),
    )
  })

  it("should reject M2M authentication when permitted_client_role is expired", async () => {
    const secretHash = await Bun.password.hash("ci-secret")

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

          const [ciRole] = yield* db
            .insert(schema.role)
            .values({
              name: "CI Runner",
              orgUnitId: rootOrgUnit.id,
              path: "/CI",
            })
            .returning()

          if (!ciRole) throw new Error("Failed to create role")

          const [oauthClient] = yield* db
            .insert(schema.oauthClient)
            .values({
              clientId: "ci-client",
              clientSecretHash: secretHash,
              audience: "graphql-api",
            })
            .returning()

          if (!oauthClient) throw new Error("Failed to create oauth client")

          const now = yield* DateTime.now
          const oneHourAgo = DateTime.subtract(now, { hours: 1 })
          yield* db.insert(schema.permittedClientRole).values({
            oauthClientId: oauthClient.id,
            roleId: ciRole.id,
            updatedAt: oneHourAgo,
          })

          const { app: issuerApp2, runtime: runtime2 } =
            yield* createAuthenticationServer({
              dummyConfig: {},
              clients: [
                {
                  id: "ci-client",
                  redirectUris: [],
                  secretHash,
                },
              ],
            })
          const auth2 = createTestApp(issuerApp2, { runtime: runtime2 })

          const basic = Buffer.from("ci-client:ci-secret").toString("base64")
          const response: Response = yield* Effect.promise<Response>(() =>
            auth2.request("https://auth.example.com/oauth/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basic}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                scope: `role:${encodeURIComponent("/CI")}`,
              }).toString(),
            }),
          )

          expect(response.status).toBe(400)
          const error = (yield* Effect.promise(() => response.json())) as {
            error: string
            error_description: string
          }
          expect(error.error).toBe("invalid_scope")
          expect(error.error_description).toContain("expired")
        }),
        TestLayer,
      ),
    )
  })
})
