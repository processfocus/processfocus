import { FetchHttpClient, HttpApp } from "@effect/platform"
import { Effect, Layer, Schedule } from "effect"
import { buildFrontendClients, createAuthenticationServer } from "@pf/auth-api"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import * as schema from "@pf/drizzle-sqlite"
import { type IssuerClient, hashClientSecret } from "@pf/openauth"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "@pf/sqlite-operations"
import { serveWithPortFallback } from "../server-utils"
import { beforeAll, describe, expect, it } from "bun:test"

// Base port for authentication server tests (different from graphql server tests)
const BASE_TEST_PORT = 14200

// Test clients for authentication server
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
    const webHandler = HttpApp.toWebHandlerRuntime(runtime)(app)
    const fetchHandler = (req: Request) => webHandler(req)

    const server = yield* serveWithPortFallback(port, {
      fetch: fetchHandler,
    })

    // Wait for server to be ready with retry
    yield* Effect.retry(
      Effect.tryPromise(() =>
        fetch(`http://localhost:${server.port}/.well-known/jwks.json`),
      ),
      Schedule.exponential("50 millis").pipe(
        Schedule.compose(Schedule.recurs(10)),
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

          // Start server and get the actual server instance
          const server = yield* Effect.acquireRelease(
            startAuthServer(testPort),
            (server) => Effect.promise(() => server.stop()),
          )

          // Verify the server is running on expected port
          expect(server.port).toBe(testPort)

          // Make request to JWKS endpoint
          const response = yield* Effect.tryPromise(() =>
            fetch(`http://localhost:${server.port}/.well-known/jwks.json`),
          )

          // Parse and verify response
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

          // Second server should be on the next port
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
    "should recognize dynamically inserted OAuth client immediately",
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
          const webHandler = HttpApp.toWebHandlerRuntime(runtime)(app)
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
            Schedule.exponential("50 millis").pipe(
              Schedule.compose(Schedule.recurs(10)),
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
        }),
      )

      await Effect.runPromise(testProgram.pipe(Effect.provide(TestLayer)))
    },
    { timeout: 10000 },
  )

  it("buildFrontendClients returns no clients in production", async () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    const originalOpenauthClients = process.env["OPENAUTH_CLIENTS"]
    const originalOauthClientId = process.env["OAUTH_CLIENT_ID"]

    process.env["NODE_ENV"] = "production"
    delete process.env["OPENAUTH_CLIENTS"]
    delete process.env["OAUTH_CLIENT_ID"]

    try {
      const clients = await buildFrontendClients()
      expect(clients).toEqual([])
    } finally {
      if (originalNodeEnv === undefined) delete process.env["NODE_ENV"]
      else process.env["NODE_ENV"] = originalNodeEnv

      if (originalOpenauthClients === undefined)
        delete process.env["OPENAUTH_CLIENTS"]
      else process.env["OPENAUTH_CLIENTS"] = originalOpenauthClients

      if (originalOauthClientId === undefined)
        delete process.env["OAUTH_CLIENT_ID"]
      else process.env["OAUTH_CLIENT_ID"] = originalOauthClientId
    }
  })

  it("buildFrontendClients creates a client_jwt frontend client in development", async () => {
    const originalNodeEnv = process.env["NODE_ENV"]
    const originalOpenauthClients = process.env["OPENAUTH_CLIENTS"]
    const originalOauthClientId = process.env["OAUTH_CLIENT_ID"]
    const originalOauthAudience = process.env["OAUTH_AUDIENCE"]

    process.env["NODE_ENV"] = "development"
    delete process.env["OPENAUTH_CLIENTS"]
    delete process.env["OAUTH_CLIENT_ID"]
    process.env["OAUTH_AUDIENCE"] = "graphql-api"

    try {
      const clients = await buildFrontendClients()
      expect(clients).toEqual([
        {
          id: "frontend",
          redirectUris: ["http://localhost/api/auth/callback"],
          audience: "graphql-api",
          tokenEndpointAuthMethod: "client_jwt",
        },
      ])
      expect(clients[0]?.secretHash).toBeUndefined()
    } finally {
      if (originalNodeEnv === undefined) delete process.env["NODE_ENV"]
      else process.env["NODE_ENV"] = originalNodeEnv

      if (originalOpenauthClients === undefined)
        delete process.env["OPENAUTH_CLIENTS"]
      else process.env["OPENAUTH_CLIENTS"] = originalOpenauthClients

      if (originalOauthClientId === undefined)
        delete process.env["OAUTH_CLIENT_ID"]
      else process.env["OAUTH_CLIENT_ID"] = originalOauthClientId

      if (originalOauthAudience === undefined)
        delete process.env["OAUTH_AUDIENCE"]
      else process.env["OAUTH_AUDIENCE"] = originalOauthAudience
    }
  })
})
