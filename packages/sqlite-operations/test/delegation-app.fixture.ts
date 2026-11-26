import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { createAuthenticationServer } from "@pf/auth-api"
import { makeDelegationManagementHandler } from "@pf/delegation/authorization"
import { type Issuer, KeyManagementService } from "@pf/openauth"

/** Storage/HTTP contract fixture. Production serves management in GraphQL;
 * the full runtime journey owns routing and remote-JWKS integration coverage. */
export const createDelegationTestApp = (
  options: Parameters<typeof createAuthenticationServer>[0],
  issuerUrls = ["https://auth.example.com", "http://127.0.0.1:4020"],
) =>
  Effect.gen(function* () {
    const issuer = yield* createAuthenticationServer(options)
    const management = yield* Effect.gen(function* () {
      const keys = yield* KeyManagementService
      return yield* makeDelegationManagementHandler({
        issuerUrls,
        audience: ["frontend", "graphql-api"],
        jwks: async (header) => {
          const keysNow = await Effect.runPromise(keys.allSigningKeys)
          const key = keysNow.find(
            (key) => key.id === header.kid && key.alg === header.alg,
          )
          if (!key) throw new Error("Unknown signing key")
          return key.public
        },
      })
    }).pipe(Effect.provide(issuer.runtime))
    const app: Issuer = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* new URL(request.url, "https://localhost").pathname ===
      "/delegations"
        ? management
        : issuer.app
    })
    return { app, runtime: issuer.runtime }
  })
