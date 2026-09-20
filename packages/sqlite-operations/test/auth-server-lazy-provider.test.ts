import { Effect } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

describe("auth-server lazy provider loading", () => {
  it("should lazy-load Google provider config from database and redirect to OAuth", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          // Create required org unit
          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          // Insert Google OAuth provider config into database
          // This simulates a provider configured via database rather than code
          yield* db.insert(schema.oauthProvider).values({
            providerName: "google",
            providerConfig: {
              clientID: "test-google-client-id",
              clientSecret: "test-google-secret",
              scopes: ["openid", "email", "profile"],
            },
          })

          // Create auth server WITHOUT dummyConfig - providers load from DB on demand
          const { app: issuerApp, runtime } = yield* createAuthenticationServer(
            {
              clients: [
                {
                  id: "test-client",
                  redirectUris: ["https://test.example.com/callback"],
                },
              ],
            },
          )
          const auth = createTestApp(issuerApp, { runtime })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "test-client",
            fetch: (a, b) => Promise.resolve(auth.request(a, b)),
          })

          // Initiate auth flow - this should:
          // 1. Redirect to /oauth/google/authorize
          // 2. Trigger lazy loading of "google" provider from DB
          // 3. Redirect to Google's OAuth authorization URL
          const { url } = yield* Effect.promise(() =>
            client.authorize("https://test.example.com/callback", "code", {
              pkce: true,
              provider: "google",
            }),
          )

          // First request - initiates OAuth flow
          let response: Response = yield* Effect.promise<Response>(() =>
            auth.request(url),
          )
          expect(response.status).toBe(302)
          expect(response.headers.get("location")).toContain(
            "/oauth/google/authorize",
          )

          // Follow redirect to provider authorize endpoint
          response = yield* Effect.promise<Response>(() =>
            auth.request(response.headers.get("location")!, {
              headers: {
                cookie: response.headers.get("set-cookie")!,
              },
            }),
          )

          // Should redirect to Google's OAuth authorization URL
          expect(response.status).toBe(302)
          const googleAuthUrl = response.headers.get("location")!
          expect(googleAuthUrl).toContain("accounts.google.com")
          expect(googleAuthUrl).toContain("client_id=test-google-client-id")
          // Verify redirect_uri includes the /oauth/google/callback path
          expect(googleAuthUrl).toContain(
            encodeURIComponent("/oauth/google/callback"),
          )
        }),
        TestLayer,
      ),
    )
  })

  it("should return 404 for non-existent provider", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          // Create root org unit (required for auth server)
          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          // Create auth server with no providers configured
          const { app: issuerApp2, runtime: runtime2 } =
            yield* createAuthenticationServer({
              clients: [
                {
                  id: "test-client",
                  redirectUris: ["https://test.example.com/callback"],
                },
              ],
            })
          const auth2 = createTestApp(issuerApp2, { runtime: runtime2 })

          // Try to access a non-existent provider
          const response: Response = yield* Effect.promise<Response>(() =>
            auth2.request(
              "https://auth.example.com/oauth/nonexistent/authorize",
              {
                method: "GET",
              },
            ),
          )

          expect(response.status).toBe(404)
          const text = yield* Effect.promise(() => response.text())
          expect(text).toContain("not found")
        }),
        TestLayer,
      ),
    )
  })

  it("should cache provider after first load", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          // Insert OAuth provider
          yield* db.insert(schema.oauthProvider).values({
            providerName: "google",
            providerConfig: {
              clientID: "test-google-client-id",
              clientSecret: "test-google-secret",
              scopes: ["openid", "email", "profile"],
            },
          })

          const { app: issuerApp3, runtime: runtime3 } =
            yield* createAuthenticationServer({
              clients: [
                {
                  id: "test-client",
                  redirectUris: ["https://test.example.com/callback"],
                },
              ],
            })
          const auth3 = createTestApp(issuerApp3, { runtime: runtime3 })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "test-client",
            fetch: (a, b) => Promise.resolve(auth3.request(a, b)),
          })

          // First request - loads provider from database
          const { url: url1 } = yield* Effect.promise(() =>
            client.authorize("https://test.example.com/callback", "code", {
              pkce: true,
              provider: "google",
            }),
          )

          let response1: Response = yield* Effect.promise<Response>(() =>
            auth3.request(url1),
          )
          expect(response1.status).toBe(302)

          // Follow through to trigger actual provider loading
          response1 = yield* Effect.promise<Response>(() =>
            auth3.request(response1.headers.get("location")!, {
              headers: { cookie: response1.headers.get("set-cookie")! },
            }),
          )
          expect(response1.status).toBe(302)
          expect(response1.headers.get("location")).toContain(
            "accounts.google.com",
          )

          // Second request - should use cached provider (not query DB again)
          const { url: url2 } = yield* Effect.promise(() =>
            client.authorize("https://test.example.com/callback", "code", {
              pkce: true,
              provider: "google",
            }),
          )

          let response2: Response = yield* Effect.promise<Response>(() =>
            auth3.request(url2),
          )
          expect(response2.status).toBe(302)

          // Follow through
          response2 = yield* Effect.promise<Response>(() =>
            auth3.request(response2.headers.get("location")!, {
              headers: { cookie: response2.headers.get("set-cookie")! },
            }),
          )
          expect(response2.status).toBe(302)
          expect(response2.headers.get("location")).toContain(
            "accounts.google.com",
          )
        }),
        TestLayer,
      ),
    )
  })

  it("should log when provider is loaded from database", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          // Insert GitHub OAuth provider config
          yield* db.insert(schema.oauthProvider).values({
            providerName: "github",
            providerConfig: {
              clientID: "test-github-client-id",
              clientSecret: "test-github-secret",
              scopes: ["read:user", "user:email"],
            },
          })

          const { app: issuerApp4, runtime: runtime4 } =
            yield* createAuthenticationServer({
              clients: [
                {
                  id: "test-client",
                  redirectUris: ["https://test.example.com/callback"],
                },
              ],
            })
          const auth4 = createTestApp(issuerApp4, { runtime: runtime4 })

          const client = createClient({
            issuer: "https://auth.example.com",
            clientID: "test-client",
            fetch: (a, b) => Promise.resolve(auth4.request(a, b)),
          })

          // Request authorize with github provider
          const { url } = yield* Effect.promise(() =>
            client.authorize("https://test.example.com/callback", "code", {
              pkce: true,
              provider: "github",
            }),
          )

          let response4: Response = yield* Effect.promise<Response>(() =>
            auth4.request(url),
          )
          expect(response4.status).toBe(302)

          // Follow redirect to trigger provider loading
          response4 = yield* Effect.promise<Response>(() =>
            auth4.request(response4.headers.get("location")!, {
              headers: { cookie: response4.headers.get("set-cookie")! },
            }),
          )

          // Should redirect to GitHub's OAuth authorization URL
          expect(response4.status).toBe(302)
          expect(response4.headers.get("location")).toContain("github.com")
        }),
        TestLayer,
      ),
    )
  })

  it("should include database providers in well-known endpoint providers_supported", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          // Insert multiple OAuth providers into database
          yield* db.insert(schema.oauthProvider).values([
            {
              providerName: "google",
              providerConfig: {
                clientID: "test-google-client-id",
                clientSecret: "test-google-secret",
                scopes: ["openid", "email", "profile"],
              },
            },
            {
              providerName: "passkey",
              providerConfig: {
                rpName: "Test App",
                rpID: "example.com",
                origin: "https://example.com",
              },
            },
          ])

          const { app: issuerApp5, runtime: runtime5 } =
            yield* createAuthenticationServer({
              clients: [
                {
                  id: "test-client",
                  redirectUris: ["https://test.example.com/callback"],
                },
              ],
            })
          const auth5 = createTestApp(issuerApp5, { runtime: runtime5 })

          // Request the well-known endpoint
          const response5: Response = yield* Effect.promise<Response>(() =>
            auth5.request(
              "https://auth.example.com/.well-known/oauth-authorization-server",
            ),
          )

          expect(response5.status).toBe(200)
          const metadata = yield* Effect.promise(() => response5.json())

          // Should include both database providers
          const providersSupported = (
            metadata as { providers_supported: string[] }
          ).providers_supported
          expect(providersSupported).toContain("google")
          expect(providersSupported).toContain("passkey")
        }),
        TestLayer,
      ),
    )
  })
})
