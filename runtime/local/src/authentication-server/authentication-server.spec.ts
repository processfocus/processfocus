import { ConfigProvider, DateTime, Effect, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { LocalAuditLive } from "@pf/audit/local"
import {
  buildFrontendClients,
  createAuthenticationFetchHandler,
  createAuthenticationServer,
  createClientJwt,
} from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import * as schema from "@pf/drizzle-sqlite"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { type IssuerClient, hashClientSecret } from "@pf/openauth"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuditPersistenceLive,
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  SqliteSettingsQueriesLive,
} from "@pf/sqlite-operations"
import { serveWithPortFallback } from "../server-utils"
import { beforeAll, describe, expect, it } from "bun:test"

// Base port for authentication server tests (different from graphql server tests)
const BASE_TEST_PORT = 14200

let testClients: IssuerClient[]

beforeAll(async () => {
  const secretHash = await hashClientSecret("test-client-secret")
  testClients = [
    {
      id: "test-client",
      redirectUris: ["http://localhost:3000/callback"],
      secretHash,
    },
  ]
})

/**
 * Inserts a test OAuth provider into the database.
 * Required because createAuthenticationServer now loads providers from DB.
 */
const insertTestOAuthProvider = Effect.gen(function* () {
  const db = yield* TypedSqliteDrizzle
  yield* db.insert(schema.oauthProvider).values({
    providerName: "google",
    providerConfig: {
      clientID: "test-client-id",
      clientSecret: "test-client-secret",
      scopes: ["openid", "email", "profile"],
    },
  })
})

/**
 * Creates the test layer stack for the authentication server.
 * Uses in-memory SQLite database for testing.
 */
const createTestLayers = () => {
  const AuthenticationLayer = SqliteAuthenticationDatabaseLive.pipe(
    Layer.provideMerge(DatabaseTest),
  )

  const StorageLayer = SqliteOpenAuthStorageServiceLive.pipe(
    Layer.provideMerge(AuthenticationLayer),
  )

  return Layer.mergeAll(
    LocalAuditLive.pipe(
      Layer.provide(SqliteAuditPersistenceLive),
      Layer.provide(DatabaseTest),
    ),
    StorageLayer,
    FetchHttpClient.layer,
    LocalCedarAuthorizationLive.pipe(Layer.provide(LocalCedarConfigStatic())),
  )
}

/**
 * Starts the authentication server and waits for it to be ready.
 * Returns the server instance for cleanup.
 */
const startAuthServer = (port: number) =>
  Effect.gen(function* () {
    const { app, runtime } = yield* createAuthenticationServer({
      clients: testClients,
    })

    // Convert HttpApp to web handler using the runtime from createAuthenticationServer
    // which has all required services (KeyManagement, Encryption, Storage, etc.)
    const webHandler = createAuthenticationFetchHandler(app, runtime, "local")
    const fetchHandler = (req: Request) => webHandler(req)

    const server = yield* serveWithPortFallback(port, {
      fetch: fetchHandler,
    })

    // Wait for server to be ready with retry
    yield* Effect.retry(
      Effect.tryPromise(() =>
        fetch(`http://localhost:${server.port}/.well-known/jwks.json`),
      ),
      Schedule.exponential("50 millis").pipe((schedule) =>
        Schedule.max([schedule, Schedule.recurs(10)]),
      ),
    )

    return server
  })

describe("Authentication Server", () => {
  it(
    "should start and respond to JWKS endpoint",
    async () => {
      const testPort = BASE_TEST_PORT

      const TestLayer = createTestLayers()

      const testProgram = Effect.scoped(
        Effect.gen(function* () {
          // Insert test OAuth provider (required for createAuthenticationServer)
          yield* insertTestOAuthProvider

          const server = yield* Effect.acquireRelease(
            startAuthServer(testPort),
            (server) => Effect.promise(() => server.stop()),
          )

          expect(server.port).toBe(testPort)

          const response = yield* Effect.tryPromise(() =>
            fetch(`http://localhost:${server.port}/.well-known/jwks.json`),
          )

          const jwks = yield* Effect.tryPromise(() => response.json())

          expect(response.status).toBe(200)
          expect(jwks).toBeDefined()
          expect(jwks.keys).toBeDefined()
          expect(Array.isArray(jwks.keys)).toBe(true)
        }),
      )

      await Effect.runPromise(testProgram.pipe(Effect.provide(TestLayer)))
    },
    { timeout: 5000 },
  )

  it(
    "should use next available port when base port is in use",
    async () => {
      const testPort = BASE_TEST_PORT + 1

      const TestLayer = createTestLayers()

      const testProgram = Effect.scoped(
        Effect.gen(function* () {
          // Insert test OAuth provider (required for createAuthenticationServer)
          yield* insertTestOAuthProvider

          // Start first server on the base port
          const firstServer = yield* Effect.acquireRelease(
            startAuthServer(testPort),
            (server) => Effect.promise(() => server.stop()),
          )

          expect(firstServer.port).toBe(testPort)

          // Start second server - should fall back to next port
          const secondServer = yield* Effect.acquireRelease(
            startAuthServer(testPort),
            (server) => Effect.promise(() => server.stop()),
          )

          expect(secondServer.port).toBe(testPort + 1)

          // Verify both servers are responding
          const [firstResponse, secondResponse] = yield* Effect.all([
            Effect.tryPromise(() =>
              fetch(
                `http://localhost:${firstServer.port}/.well-known/jwks.json`,
              ),
            ),
            Effect.tryPromise(() =>
              fetch(
                `http://localhost:${secondServer.port}/.well-known/jwks.json`,
              ),
            ),
          ])

          expect(firstResponse.status).toBe(200)
          expect(secondResponse.status).toBe(200)
        }),
      )

      await Effect.runPromise(testProgram.pipe(Effect.provide(TestLayer)))
    },
    { timeout: 6000 },
  )

  it(
    "recognizes dynamic OAuth clients without changing machine last-login fallback",
    async () => {
      const testPort = BASE_TEST_PORT + 10

      const TestLayer = createTestLayers()

      const testProgram = Effect.scoped(
        Effect.gen(function* () {
          // Insert test OAuth provider (required for createAuthenticationServer)
          yield* insertTestOAuthProvider

          // Test requires dynamic lookup without static config
          const { app, runtime } = yield* createAuthenticationServer({
            clients: testClients,
          })

          // Convert HttpApp to web handler using the runtime from createAuthenticationServer
          const webHandler = HttpEffect.toWebHandlerWith<
            never,
            Effect.Services<typeof app>
          >(runtime)(app)
          const fetchHandler = (req: Request) => webHandler(req)

          const server = yield* Effect.acquireRelease(
            serveWithPortFallback(testPort, {
              fetch: fetchHandler,
            }),
            (s) => Effect.promise(() => s.stop()),
          )

          yield* Effect.retry(
            Effect.tryPromise(() =>
              fetch(`http://localhost:${server.port}/.well-known/jwks.json`),
            ),
            Schedule.exponential("50 millis").pipe((schedule) =>
              Schedule.max([schedule, Schedule.recurs(10)]),
            ),
          )

          const clientSecret = "dynamic-client-secret"
          const secretHash = yield* Effect.promise(() =>
            hashClientSecret(clientSecret),
          )

          // Insert client while server is running to test dynamic recognition
          const db = yield* TypedSqliteDrizzle
          yield* db.insert(schema.oauthClient).values({
            clientId: "dynamic-m2m-client",
            clientSecretHash: secretHash,
            audience: "graphql-api",
          })

          const createdAt = DateTime.makeUnsafe(0)
          yield* db.insert(schema.user).values({
            provider: "client_credentials",
            sub: "dynamic-m2m-client",
            createdAt,
          })

          // Verify immediate recognition without server restart
          const tokenResponse = yield* Effect.tryPromise(() =>
            fetch(`http://localhost:${server.port}/oauth/token`, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${btoa(`dynamic-m2m-client:${clientSecret}`)}`,
              },
              body: new URLSearchParams({
                grant_type: "client_credentials",
              }),
            }),
          )

          expect(tokenResponse.status).toBe(200)
          const tokenData = yield* Effect.tryPromise(() => tokenResponse.json())
          expect(tokenData.access_token).toBeDefined()
          const users = yield* (yield* SettingsQueries).queryAllUsers(1, 10)
          expect(users.totalCount).toBe(1)
          expect(users.items[0]!.lastLoggedIn.getTime()).toBe(0)
          expect(yield* db.select().from(schema.auditEvent)).toEqual([])
        }),
      )

      await Effect.runPromise(
        testProgram.pipe(
          Effect.provide(
            SqliteSettingsQueriesLive.pipe(Layer.provideMerge(TestLayer)),
          ),
        ),
      )
    },
    { timeout: 10000 },
  )

  it.each([
    ["production", undefined, 0],
    ["development", undefined, 1],
    ["development", "", 1],
    ["development", "[]", 0],
    ["", undefined, 0],
    [undefined, undefined, 0],
  ])(
    "frontend defaults for NODE_ENV=%s OPENAUTH_CLIENTS=%s",
    async (nodeEnv, clients, count) => {
      const result = await Effect.runPromise(
        buildFrontendClients().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NODE_ENV: nodeEnv,
                OPENAUTH_CLIENTS: clients,
              }),
            ),
          ),
        ),
      )
      expect(result).toHaveLength(count)
      if (count) {
        expect(result[0]?.tokenEndpointAuthMethod).toBe("client_jwt")
        expect(result[0]?.redirectUris).toEqual([
          "http://localhost/api/auth/callback",
        ])
        expect(result[0]?.secretHash).toBeUndefined()
      }
    },
  )

  it.each(["production", "development", "", undefined])(
    "dummy provider production restriction uses ConfigProvider (%s)",
    async (nodeEnv) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          createAuthenticationServer({
            dummyConfig: {},
            clients: testClients,
          }).pipe(
            Effect.match({
              onFailure: (error) => error._tag,
              onSuccess: () => "allowed",
            }),
            Effect.provide(createTestLayers()),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ NODE_ENV: nodeEnv }),
              ),
            ),
          ),
        ),
      )
      expect(result).toBe(
        nodeEnv === "production" ? "ProviderConfigurationError" : "allowed",
      )
    },
  )

  it.each(["development", "production", "", undefined])(
    "client JWT loopback port restriction uses the captured ConfigProvider (%s)",
    async (nodeEnv) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const clientId = "frontend"
            const token = yield* createClientJwt({
              clientId,
              issuerUrl: "http://localhost:3000",
              audience: "graphql-api",
            })
            const { app, runtime } = yield* createAuthenticationServer({
              clients: [
                {
                  id: clientId,
                  redirectUris: [],
                  tokenEndpointAuthMethod: "client_jwt",
                },
              ],
            })
            const handler = HttpEffect.toWebHandlerWith<
              never,
              Effect.Services<typeof app>
            >(runtime)(app)
            const response = yield* Effect.promise(() =>
              handler(
                new Request("http://localhost:3001/oauth/token", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization: `Bearer ${token}`,
                    Host: "localhost:3001",
                  },
                  body: new URLSearchParams({
                    grant_type: "client_credentials",
                    client_id: clientId,
                  }),
                }),
              ),
            )
            expect(response.status).toBe(nodeEnv === "development" ? 200 : 401)
            if (nodeEnv !== "development") {
              const body = yield* Effect.promise(() => response.json())
              expect(body.error).toBe("invalid_client")
            }
          }).pipe(
            Effect.provide(createTestLayers()),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ NODE_ENV: nodeEnv }),
              ),
            ),
          ),
        ),
      )
    },
  )
})
