import { generateKeyPairSync, sign } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { createAuthenticationServer } from "@pf/auth-api"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "@pf/sqlite-operations"
import { runDeploy } from "../src/commands/deploy"
import {
  acquireAccessToken,
  readWorkloadCredentials,
} from "../src/utils/credentials"
import { createExecutionEventSource } from "../src/utils/execution-subscription"
import { graphqlRequest } from "../src/utils/graphql-client"
import { useSerializedTestState, withEnv } from "./test-helpers"
import { expect, it, spyOn } from "bun:test"

useSerializedTestState()

// Keep this real-time renewal matrix in slow-test: each scenario crosses
// multiple token lifetimes using the real issuer and socket transports.
// JWT expiry and expires_in round down to seconds. Leave time for the real
// permission and scoped-token exchanges before forcing the next renewal.
const lifetimeSeconds = 5
const lifetimeMs = lifetimeSeconds * 1000

// Real issuer, trust database, signed evidence, HTTP and WebSocket transports.
// The hosted deploy worker is represented by a controlled API fixture: it records
// one dispatch and completes silently, requiring authoritative polling recovery.
// The successful machine AppSync case also renews the execution socket.
it.each([false, true])(
  "renews a machine deploy using authorized execution updates (AppSync=%s) without replaying dispatch",
  async (appsync) => {
    const root = mkdtempSync(join(tmpdir(), "workload-deploy-"))
    mkdirSync(join(root, "dist"))
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = {
      ...key.publicKey.export({ format: "jwk" }),
      kid: "github",
      alg: "RS256",
    }
    const githubKeys = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.url).toBe(
          "https://token.actions.githubusercontent.com/.well-known/jwks",
        )
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ keys: [jwk] }),
        )
      }),
    )
    const layer = Layer.mergeAll(
      LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
      SqliteAuthenticationDatabaseLive,
      SqliteOpenAuthStorageServiceLive,
      Layer.succeed(HttpClient.HttpClient, githubKeys),
      Layer.succeed(RequestTime, DateTime.nowUnsafe()),
    ).pipe(Layer.provideMerge(DatabaseTest))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle
          const authentication = yield* createAuthenticationServer({
            clients: [
              { id: "frontend", redirectUris: ["http://localhost/callback"] },
            ],
          })
          const auth = createTestApp(authentication.app, {
            runtime: authentication.runtime,
          })
          let baseUrl = ""
          let assertions = 0
          let exchanges = 0
          let expiredEvidence = false
          let dispatches = 0
          let startedAt = 0
          let polls = 0
          const apiTokens = new Set<string>()
          const socketTokens = new Set<string>()
          const issuedAssertions: string[] = []
          const apiBodies: string[] = []
          const verify = async (token: string) => {
            const client = createClient({
              issuer: baseUrl,
              clientID: "deploy",
              fetch: (url, init) => auth.request(url, init),
            })
            const result = await client.verify(subjects, token, {
              audience: "graphql-api",
            })
            if (result.err) return false
            return (
              result.subject.type === "user" &&
              result.subject.properties.clientId === "deploy"
            )
          }
          const server = Bun.serve<{
            token?: string
          }>({
            hostname: "127.0.0.2",
            port: 0,
            async fetch(request, server) {
              const url = new URL(request.url)
              if (url.pathname === "/github") {
                expect(request.headers.get("authorization")).toBe(
                  "Bearer job-only-capability",
                )
                expect(url.searchParams.get("audience")).toBe(
                  "pf:local:renewal",
                )
                assertions++
                const now = Math.floor(Date.now() / 1000)
                const claims = {
                  iss: "https://token.actions.githubusercontent.com",
                  aud: "pf:local:renewal",
                  sub: "repo:owner/repo:environment:test",
                  iat: now,
                  nbf: now,
                  exp: expiredEvidence ? now - 60 : now + 60,
                  repository_id: "123",
                  repository_owner_id: "456",
                  workflow_ref:
                    "owner/repo/.github/workflows/deploy.yml@refs/heads/trunk",
                  ref: "refs/heads/trunk",
                  event_name: "push",
                  environment: "test",
                  sha: "abc",
                  run_id: "789",
                  run_attempt: "1",
                  jti: String(assertions),
                }
                const signingInput = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "github" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`
                const value = `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey).toString("base64url")}`
                issuedAssertions.push(value)
                return Response.json({ value })
              }
              if (url.pathname === "/oauth/token") {
                const form = await request.clone().formData()
                if (
                  form.get("subject_token_type") ===
                  "urn:ietf:params:oauth:token-type:id_token"
                )
                  exchanges++
                const response = await auth.request(request)
                const body = await response.clone().json()
                expect(body).not.toHaveProperty("refresh_token")
                return response
              }
              if (url.pathname === "/upload") return new Response("uploaded")
              if (request.headers.get("upgrade") === "websocket") {
                const protocol = request.headers
                  .get("sec-websocket-protocol")
                  ?.split(",")
                  .map((part) => part.trim())
                  .find((part) => part.startsWith("header-"))
                const token: string | undefined = protocol
                  ? JSON.parse(
                      Buffer.from(protocol.slice(7), "base64url").toString(),
                    ).authorization
                  : undefined
                if (server.upgrade(request, { data: token ? { token } : {} }))
                  return
                return new Response("Upgrade failed", { status: 400 })
              }
              const token =
                request.headers.get("authorization")?.replace(/^Bearer /, "") ??
                ""
              if (url.pathname === "/graphql") {
                const body = Schema.decodeUnknownSync(
                  Schema.Struct({
                    query: Schema.String,
                    variables: Schema.Record(Schema.String, Schema.Unknown),
                  }),
                )(await request.clone().json())
                if (body.query.includes("requestProviderUserPermissions")) {
                  throw new Error(
                    "A machine deployment must not request impersonation",
                  )
                }
              }
              if (!(await verify(token)))
                return new Response("Expired or invalid", { status: 401 })
              apiTokens.add(token)
              const text = await request.text()
              apiBodies.push(text)
              const { query } = JSON.parse(text)
              if (query.includes("ActiveDeploy"))
                return Response.json({ data: { activeDeploy: null } })
              const data = query.includes("HostingContract")
                ? {}
                : query.includes("ListProjectEnvironments")
                  ? {
                      listProjectEnvironments: {
                        items: [{ environmentName: "test" }],
                      },
                    }
                  : query.includes("RequestUploadUrl")
                    ? {
                        requestUploadUrl: {
                          fileId: "artifact",
                          uploadUrl: `${baseUrl}/upload`,
                        },
                      }
                    : query.includes("SubscriptionTransport")
                      ? {
                          subscriptionTransport: appsync
                            ? {
                                kind: "APPSYNC_EVENTS",
                                appSyncEventsHttpHost: "fixture.invalid",
                              }
                            : { kind: "GRAPHQL_WS" },
                        }
                      : query.includes("StartDeploy")
                        ? (() => {
                            dispatches++
                            startedAt = Date.now()
                            return {
                              startOperationsDeploy: {
                                executionId: "execution-1",
                                processPath: "/operations/deploy",
                              },
                            }
                          })()
                        : query.includes("DeployExecutionSnapshot")
                          ? (() => {
                              polls++
                              return {
                                execution: {
                                  id: "execution-1",
                                  status:
                                    Date.now() - startedAt >= lifetimeMs + 500
                                      ? "Completed"
                                      : "Running",
                                  failureReason: null,
                                  abandonedReason: null,
                                  finishedAt: null,
                                  steps: [],
                                },
                              }
                            })()
                          : {
                              getDnsRecords: {
                                frontendUrl: "https://deployed.example",
                                customDomain: null,
                                frontendUrlNote: null,
                              },
                            }
              return Response.json({ data })
            },
            websocket: {
              async message(socket, message) {
                const frame = JSON.parse(String(message))
                if (frame.type === "connection_init") {
                  const token: string =
                    frame.payload?.token ?? socket.data.token
                  if (!(await verify(token))) {
                    socket.close(4401)
                    return
                  }
                  socket.data.token = token
                  socketTokens.add(token)
                  socket.send(JSON.stringify({ type: "connection_ack" }))
                }
              },
            },
          })
          baseUrl = `http://127.0.0.2:${server.port}`
          const trust = {
            id: "deploy",
            targetIssuer: baseUrl,
            issuer: "https://token.actions.githubusercontent.com",
            assertionAudience: "pf:local:renewal",
            repositoryId: "123",
            repositoryOwnerId: "456",
            workflowRef:
              "owner/repo/.github/workflows/deploy.yml@refs/heads/trunk",
            refs: ["refs/heads/trunk"],
            events: ["push"],
            environment: "test",
            lifetimeSeconds,
          }
          try {
            yield* db
              .insert(schema.oauthClient)
              .values({
                clientId: "deploy",
                clientSecretHash: "",
                audience: "graphql-api",
                workloadTrust: {
                  bindings: [trust],
                  deploymentProjects: ["project"],
                },
              })
              .returning()
            yield* Effect.promise(() =>
              withEnv(
                {
                  PFCLI_AUTH_MODE: "github-workload",
                  PFCLI_WORKLOAD_PROVIDER_USER: undefined,
                  PFCLI_BASE_URL: baseUrl,
                  PFCLI_GITHUB_AUDIENCE: "pf:local:renewal",
                  ACTIONS_ID_TOKEN_REQUEST_URL: `${baseUrl}/github`,
                  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "job-only-capability",
                  CI_PIPELINE_SECRET: "must-not-be-used",
                  PFCLI_CREDENTIALS_PATH: join(root, "credentials.json"),
                  PFCLI_DEPLOY_WAIT_TIMEOUT_MS: "2000",
                },
                async () => {
                  const output: string[] = []
                  const write = spyOn(
                    process.stdout,
                    "write",
                  ).mockImplementation((chunk) => {
                    output.push(String(chunk))
                    return true
                  })
                  try {
                    const deployment = Effect.runPromise(
                      runDeploy(
                        root,
                        "project",
                        "test",
                        {},
                        {
                          // Preserve real issuer/renewal/socket behavior while substituting
                          // managed AppSync transport.
                          createExecutionEventSource: (config) =>
                            createExecutionEventSource({
                              kind: "GRAPHQL_WS",
                              wsEndpoint: `${baseUrl.replace("http:", "ws:")}/graphql`,
                              accessToken: config.accessToken,
                            }),
                          createDeployProgressEventSource: () =>
                            Effect.die(
                              "Unexpected auxiliary machine progress subscription",
                            ),
                          buildOrg: () => Effect.sleep(lifetimeMs + 200),
                          prepareArtifact: (_path, artifact) =>
                            Effect.sync(() =>
                              writeFileSync(artifact, "artifact"),
                            ),
                        },
                      ),
                    )
                    await deployment
                  } finally {
                    write.mockRestore()
                  }
                  expect(dispatches).toBe(1)
                  expect(polls).toBeGreaterThanOrEqual(2)
                  expect(apiTokens.size).toBeGreaterThanOrEqual(3)
                  expect(socketTokens.size).toBeGreaterThanOrEqual(2)
                  // Completion can cancel subscription renewal after evidence
                  // acquisition but before exchange; no exchange may lack evidence.
                  expect(assertions).toBeGreaterThanOrEqual(exchanges)
                  expect(new Set(issuedAssertions).size).toBe(assertions)
                  expect(existsSync(join(root, "credentials.json"))).toBe(false)
                  expect(apiBodies.join("\n")).not.toContain(
                    "job-only-capability",
                  )
                  for (const assertion of issuedAssertions)
                    expect(apiBodies.join("\n")).not.toContain(assertion)

                  const credentials = await Effect.runPromise(
                    readWorkloadCredentials("deploy"),
                  )
                  expect(credentials).toBeDefined()
                  if (!credentials)
                    throw new Error("Missing workload credentials")
                  await Effect.runPromise(db.delete(schema.oauthClient))
                  await Bun.sleep(lifetimeMs + 100)
                  await expect(
                    Effect.runPromise(
                      graphqlRequest(
                        `${baseUrl}/graphql`,
                        acquireAccessToken(credentials),
                        "mutation StartDeploy { start }",
                        {},
                      ),
                    ),
                  ).rejects.toThrow("Workload token exchange rejected")
                  expect(dispatches).toBe(1)
                  const exchangeCount = exchanges
                  expiredEvidence = true
                  await expect(
                    Effect.runPromise(acquireAccessToken(credentials)),
                  ).rejects.toThrow("expired evidence")
                  expect(exchanges).toBe(exchangeCount)
                  delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
                  await expect(
                    Effect.runPromise(acquireAccessToken(credentials)),
                  ).rejects.toThrow("id-token: write")
                  expect(dispatches).toBe(1)
                },
              ),
            )
          } finally {
            yield* Effect.promise(() => server.stop(true))
          }
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  45_000,
)

import { LocalAuditLive } from "@pf/audit/local"
import { SqliteAuditPersistenceLive } from "@pf/sqlite-operations"
