import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Logger, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose"
import { createAuthenticationServer } from "@pf/auth-api"
import {
  AuthenticationConfig,
  type WorkloadTrustBinding,
  WorkloadTrustBindingSchema,
} from "@pf/auth-config"
import { subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import {
  KeyManagementService,
  KeyManagementServiceLive,
  Storage,
  createTestApp,
} from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { storeOrganisation } from "@pf/org-to-db"
import { Organisation } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
} from "../src/lib/authentication-database"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { expect, it } from "bun:test"

const issuer = "http://auth.example.com"
const binding: WorkloadTrustBinding = {
  id: "demo-read",
  targetIssuer: issuer,
  issuer: "https://token.actions.githubusercontent.com",
  assertionAudience: "pf:demo:test",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowRef: "owner/repo/.github/workflows/deploy.yml@refs/heads/trunk",
  refs: ["refs/heads/trunk"],
  events: ["push"],
  environment: "smoke-test",
  lifetimeSeconds: 300,
}
const organisation = (bindings: readonly WorkloadTrustBinding[]) => {
  const org = new Organisation({ name: "Workload Test" })
  new AuthenticationConfig(org, "auth", {
    workloadClients: {
      "workload-reader": { audience: "graphql-api", bindings },
    },
  })
  return org
}
const Tokens = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Schema.String,
    token_type: Schema.Literal("Bearer"),
    issued_token_type: Schema.Literal(
      "urn:ietf:params:oauth:token-type:access_token",
    ),
    expires_in: Schema.Number,
  }),
)
it("rejects workload client collisions without changing stored registrations", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const original = new Organisation({ name: "Workload Test" })
      new AuthenticationConfig(original, "secret", {
        secretClients: {
          "workload-reader": {
            secret: "test-only-secret",
            audience: "graphql-api",
          },
        },
      })
      yield* storeOrganisation(original)
      const before = yield* db.select().from(schema.oauthClient)
      for (const kind of ["secret", "empty-secret", "workload"] as const) {
        const conflicting = organisation([binding])
        new AuthenticationConfig(
          conflicting,
          "other",
          kind === "workload"
            ? {
                workloadClients: {
                  "workload-reader": {
                    audience: "other-api",
                    bindings: [binding],
                  },
                },
              }
            : {
                secretClients: {
                  "workload-reader": {
                    secret: kind === "secret" ? "replacement" : "",
                    audience: "other-api",
                  },
                },
              },
        )
        const error = yield* storeOrganisation(conflicting).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        )
        expect(error).toMatchObject({
          _tag: "WorkloadClientConflict",
          clientId: "workload-reader",
        })
        expect(yield* db.select().from(schema.oauthClient)).toEqual(before)
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteDbOperationsLive,
          Layer.succeed(RequestTime, DateTime.nowUnsafe()),
        ).pipe(Layer.provideMerge(DatabaseTest)),
      ),
    ),
  )
})

it("rejects the unsupported one-second workload lifetime", () => {
  expect(() =>
    Schema.decodeUnknownSync(WorkloadTrustBindingSchema)({
      ...binding,
      lifetimeSeconds: 1,
    }),
  ).toThrow()
})
// Owns the new admission/lifecycle contract at the real issuer and database boundary.
// Only GitHub's key transport is isolated; no trust, identity, signing or storage mocks.
it("exchanges exact workload evidence into bounded machine access", async () => {
  const first = await generateKeyPair("RS256", { extractable: true })
  const second = await generateKeyPair("RS256", { extractable: true })
  const firstJwk = {
    ...(await exportJWK(first.publicKey)),
    kid: "first",
    alg: "RS256",
  }
  const secondJwk = {
    ...(await exportJWK(second.publicKey)),
    kid: "second",
    alg: "RS256",
  }
  const pssKey = await importJWK(await exportJWK(first.privateKey), "PS256")
  let trustedKeys = [firstJwk]
  let keyStatus = 200
  const requestedUrls: string[] = []
  const diagnostics: string[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requestedUrls.push(request.url)
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ keys: trustedKeys }, { status: keyStatus }),
      )
    }),
  )
  const layer = Layer.mergeAll(
    LocalAuditLive.pipe(Layer.provide(SqliteAuditPersistenceLive)),
    SqliteAuthenticationDatabaseLive,
    SqliteOpenAuthStorageServiceLive,
    SqliteDbOperationsLive,
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(RequestTime, DateTime.nowUnsafe()),
    Logger.layer([
      Logger.make((entry) => diagnostics.push(Logger.formatSimple.log(entry))),
    ]),
  ).pipe(Layer.provideMerge(DatabaseTest))
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      yield* storeOrganisation(organisation([binding]))
      const server = yield* createAuthenticationServer({
        dummyConfig: {},
        clients: [
          { id: "frontend", redirectUris: ["http://localhost/callback"] },
        ],
      })
      const auth = createTestApp(server.app, { runtime: server.runtime })
      const verifier = createClient({
        issuer,
        clientID: "workload-reader",
        fetch: (url, init) => Promise.resolve(auth.request(url, init)),
      })
      // GitHub evidence can predate admission; the access lifetime starts at exchange.
      const now = Math.floor(Date.now() / 1000) - 2
      const claims = {
        iss: binding.issuer,
        aud: binding.assertionAudience,
        sub: "repo:owner/repo:environment:smoke-test",
        iat: now,
        nbf: now,
        exp: now + 60,
        repository_id: "123",
        repository_owner_id: "456",
        workflow_ref: binding.workflowRef,
        ref: "refs/heads/trunk",
        event_name: "push",
        environment: "smoke-test",
        sha: "abc123",
        run_id: "789",
        run_attempt: "1",
      }
      const sign = (
        overrides: Record<string, unknown> = {},
        key = first.privateKey,
        kid = "first",
        alg = "RS256",
      ) =>
        Effect.promise(() =>
          new SignJWT({ ...claims, ...overrides })
            .setProtectedHeader({
              alg,
              kid,
              jku: "https://attacker.invalid/keys",
            })
            .sign(key),
        )
      const exchange = (
        assertion: string,
        extras: Record<string, string> = {},
        target = auth,
      ) =>
        Effect.promise(() =>
          target.request(`${issuer}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
              subject_token: assertion,
              ...extras,
            }),
          }),
        )
      const assertion = yield* sign()
      // Static clients take precedence over database clients during credentials
      // authentication. Workload admission must not issue under their IDs.
      const conflictingServer = yield* createAuthenticationServer({
        dummyConfig: {},
        clients: [
          {
            id: "workload-reader",
            redirectUris: [],
            audience: "graphql-api",
            tokenEndpointAuthMethod: "client_jwt",
          },
        ],
      })
      const conflictingAuth = createTestApp(conflictingServer.app, {
        runtime: conflictingServer.runtime,
      })
      const conflictingResponse = yield* exchange(
        assertion,
        {},
        conflictingAuth,
      )
      expect(conflictingResponse.status).toBe(400)
      expect(yield* Effect.promise(() => conflictingResponse.json())).toEqual({
        error: "invalid_grant",
        error_description: "Token exchange rejected",
      })
      const response = yield* exchange(assertion)
      const exchangedAt = Math.floor(Date.now() / 1000)
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toContain("no-store")
      const body = yield* Effect.promise(() => response.json())
      expect(body).not.toHaveProperty("refresh_token")
      const tokens = Tokens(body)
      expect(tokens.expires_in).toBeGreaterThan(250)
      expect(tokens.expires_in).toBeLessThanOrEqual(300)
      const verified = yield* Effect.promise(() =>
        verifier.verify(subjects, tokens.access_token, {
          audience: "graphql-api",
        }),
      )
      if (verified.err || verified.subject.type !== "user")
        throw new Error("Expected verified machine subject")
      expect(verified.subject.properties.workload).toMatchObject({
        bindingId: binding.id,
        runId: "789",
        runAttempt: "1",
        repositoryId: "123",
      })
      expect(verified.subject.properties).not.toHaveProperty("humanSession")
      expect(
        (yield* Effect.promise(() =>
          verifier.verify(subjects, assertion, { audience: "graphql-api" }),
        )).err,
      ).toBeDefined()
      expect(
        (yield* Effect.promise(() =>
          verifier.verify(subjects, tokens.access_token, {
            audience: "other-api",
          }),
        )).err,
      ).toBeDefined()
      const keys = yield* KeyManagementService.pipe(
        Effect.provide(KeyManagementServiceLive),
      )
      const signingKey = yield* keys.signingKey
      const signed = yield* Effect.promise(() =>
        jwtVerify(tokens.access_token, signingKey.public, {
          issuer,
          audience: "graphql-api",
        }),
      )
      expect(signed.payload.exp).toBeLessThanOrEqual(exchangedAt + 300)
      expect(
        yield* Effect.tryPromise(() =>
          jwtVerify(tokens.access_token, signingKey.public, {
            issuer,
            audience: "graphql-api",
            currentDate: new Date((exchangedAt + 301) * 1000),
          }),
        ).pipe(Effect.isFailure),
      ).toBe(true)

      for (const overrides of [
        { iss: "https://attacker.invalid" },
        { aud: "other-target" },
        { exp: now - 60 },
        { nbf: now + 120 },
        { iat: now + 120 },
        { repository_id: "other" },
        { repository_owner_id: "other" },
        {
          workflow_ref:
            "owner/repo/.github/workflows/review.yml@refs/heads/trunk",
        },
        { ref: "refs/heads/other" },
        { event_name: "pull_request" },
        { environment: "production" },
        {
          job_workflow_ref:
            "owner/repo/.github/workflows/reusable.yml@refs/heads/trunk",
        },
        ...Object.keys(claims).map((key) => ({ [key]: undefined })),
      ]) {
        const rejected = yield* exchange(yield* sign(overrides))
        expect(rejected.status).toBe(400)
        expect(yield* Effect.promise(() => rejected.text())).toBe(
          '{"error":"invalid_grant","error_description":"Token exchange rejected"}',
        )
      }
      expect((yield* exchange(yield* sign({}, second.privateKey))).status).toBe(
        400,
      )
      trustedKeys = [{ ...firstJwk, alg: "PS256" }]
      const pss = yield* Effect.promise(() =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "PS256", kid: "first" })
          .sign(pssKey),
      )
      expect((yield* exchange(pss)).status).toBe(400)
      trustedKeys = [firstJwk]
      for (const extras of [
        { client_id: "frontend" },
        { audience: "other" },
        { scope: "role:/Administrator" },
        { scope: "email:owner@example.com" },
        { expires_in: "99999" },
      ]) {
        expect((yield* exchange(assertion, extras)).status).toBe(400)
      }
      trustedKeys = [secondJwk]
      const rotated = yield* sign({}, second.privateKey, "second")
      expect((yield* exchange(rotated)).status).toBe(200)
      expect((yield* exchange(assertion)).status).toBe(400)
      keyStatus = 503
      expect((yield* exchange(rotated)).status).toBe(400)
      keyStatus = 200
      expect(new Set(requestedUrls)).toEqual(
        new Set([`${binding.issuer}/.well-known/jwks`]),
      )

      yield* storeOrganisation(
        organisation([{ ...binding, lifetimeSeconds: 5400 }]),
      )
      const cappedResponse = yield* exchange(rotated)
      const capped = Tokens(yield* Effect.promise(() => cappedResponse.json()))
      expect(capped.expires_in).toBeGreaterThan(5300)
      expect(capped.expires_in).toBeLessThanOrEqual(5400)

      yield* storeOrganisation(
        organisation([{ ...binding, lifetimeSeconds: 2 }]),
      )
      const minimumResponse = yield* exchange(rotated)
      expect(minimumResponse.status).toBe(200)
      const minimum = Tokens(
        yield* Effect.promise(() => minimumResponse.json()),
      )
      expect(minimum.expires_in).toBeGreaterThan(0)
      expect(minimum.expires_in).toBeLessThanOrEqual(2)

      for (const bindings of [
        [{ ...binding, lifetimeSeconds: 5401 }],
        [binding, { ...binding, id: "ambiguous" }],
        [{ ...binding, targetIssuer: "http://other.example.com" }],
        [],
      ]) {
        yield* storeOrganisation(organisation(bindings))
        expect((yield* exchange(rotated)).status).toBe(400)
      }
      // Removal is effective for new issuance, not retroactive token revocation.
      expect(
        (yield* Effect.promise(() =>
          verifier.verify(subjects, tokens.access_token, {
            audience: "graphql-api",
          }),
        )).err,
      ).toBeUndefined()
      const storage = yield* Stream.runCollect(Storage.scan(["oauth:refresh"]))
      expect(storage).toHaveLength(0)
      expect(yield* db.select().from(schema.delegation)).toHaveLength(0)
      expect(yield* db.select().from(schema.auditEvent)).toHaveLength(0)
      const clients = yield* db
        .select()
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient._deleted, false))
      expect(clients[0]?.clientSecretHash).toBe("")
      expect(diagnostics.join("\n")).not.toContain(assertion)
      expect(diagnostics.join("\n")).not.toContain(tokens.access_token)
    }).pipe(Effect.provide(layer)),
  )
}, 30_000)

import { LocalAuditLive } from "@pf/audit/local"
import { SqliteAuditPersistenceLive } from "../src/lib/audit"
