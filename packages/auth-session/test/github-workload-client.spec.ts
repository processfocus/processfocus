import { Clock, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { generateTokens } from "../../openauth/src/endpoints/_internal/token-generation"
import {
  KeyManagementService,
  KeyManagementServiceLive,
} from "../../openauth/src/services/key-management"
import { MemoryStorageServiceLive } from "../../openauth/src/storage/memory"
import { StorageService } from "../../openauth/src/storage/storage"
import { createWorkloadSessionSource } from "../src/lib/github-workload-client"
import { expect, test } from "bun:test"

test("scoped renewal survives the parent's renewal boundary between clock reads", async () => {
  // Issuance just before a whole second leaves less than one second of JWT
  // validity at renewAt. Minting another scoped token then is rejected by
  // OpenAuth's whole-second expires_in contract.
  let now = 1_990
  // Tick on every client read to cross renewAt between the nested cache checks.
  const clock = Object.assign(Clock.Clock.defaultValue(), {
    currentTimeMillis: Effect.sync(() => now++),
  })
  const issuerClock = Object.assign(Clock.Clock.defaultValue(), {
    currentTimeMillis: Effect.sync(() => now),
  })
  const jwt = (exp: number) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
  let admissions = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const keys = yield* KeyManagementService
      const storage = yield* StorageService
      // Substitute external admission and permission APIs, but use OpenAuth's
      // real signing, deadline capping and zero-lifetime rejection.
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          let response: Response
          if (request.url.startsWith("https://github.example/")) {
            response = Response.json({ value: jwt(60) })
          } else if (request.url === "https://api.example/graphql") {
            response = Response.json({
              data: { requestRole: { success: true } },
            })
          } else {
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected a form body")
            const form = new URLSearchParams(
              new TextDecoder().decode(request.body.body),
            )
            const scoped = form.has("scope")
            if (!scoped) admissions++
            const expiresAt = scoped
              ? Schema.decodeUnknownSync(
                  Schema.fromJsonString(Schema.Struct({ exp: Schema.Number })),
                )(
                  Buffer.from(
                    form.get("subject_token")!.split(".")[1]!,
                    "base64url",
                  ).toString(),
                ).exp * 1_000
              : now + 5_000
            response = yield* generateTokens(
              {
                type: "user",
                properties: {},
                subject: "workload",
                clientID: "deploy",
                audience: "graphql-api",
                ttl: { access: 5, refresh: 0 },
                expiresAt,
                timeUsed: undefined,
                nextToken: undefined,
              },
              { generateRefreshToken: false },
            ).pipe(
              Effect.provideService(KeyManagementService, keys),
              Effect.provideService(StorageService, storage),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(request.url, {
                    headers: { host: new URL(request.url).host },
                  }),
                ),
              ),
              Effect.provideService(Clock.Clock, issuerClock),
              Effect.map((tokens) =>
                Response.json({
                  access_token: tokens.access,
                  token_type: "Bearer",
                  expires_in: tokens.expiresIn,
                }),
              ),
              Effect.catchTag("@pf/openauth/OAuthEndpointError", () =>
                Effect.succeed(
                  Response.json({ error: "invalid_grant" }, { status: 400 }),
                ),
              ),
              Effect.orDie,
            )
          }
          return HttpClientResponse.fromWeb(request, response)
        }),
      )
      const source = yield* createWorkloadSessionSource({
        tokenEndpoint: "https://auth.example/oauth/token",
        graphqlEndpoint: "https://api.example/graphql",
        assertionAudience: "test",
        jobCapability: () => ({
          requestUrl: "https://github.example/assertion",
          requestToken: "job-only",
        }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http))
      const first = yield* source.acquire("role:%2FDeployer")
      now = Math.floor(first.renewAt)
      const renewed = yield* source.acquire("role:%2FDeployer")
      expect(renewed.accessToken).toBe(first.accessToken)
      expect(renewed.expiresAt).toBeGreaterThan(now)
      now = first.renewAt + 1
      const next = yield* source.acquire("role:%2FDeployer")
      expect(next.expiresAt).toBeGreaterThan(first.expiresAt)
      expect(admissions).toBe(2)
    }).pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provide(
        KeyManagementServiceLive.pipe(
          Layer.provideMerge(MemoryStorageServiceLive),
        ),
      ),
    ),
  )
})
