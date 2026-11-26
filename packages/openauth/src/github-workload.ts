import { Clock, Data, Effect, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { decodeJwt } from "jose"

export class WorkloadAuthenticationError extends Data.TaggedError("WorkloadAuthenticationError")<{
  readonly message: string
}> {}

export interface WorkloadCredential {
  readonly accessToken: string
  readonly expiresAt: number
  readonly renewAt: number
}

export interface GitHubWorkloadCredentialSource {
  readonly acquire: Effect.Effect<WorkloadCredential, WorkloadAuthenticationError>
}

/** Job-local acquisition only: neither assertions nor request capability are persisted.
 * Consumers acquire before each request; mutations must never be retried on auth failure.
 */
export const createGitHubWorkloadCredentialSource = (options: {
  readonly tokenEndpoint: string
  readonly assertionAudience: string
  readonly clientId?: string
  readonly scope?: string
  readonly jobCapability: () => {
    readonly requestUrl: string | undefined
    readonly requestToken: string | undefined
  }
}): Effect.Effect<GitHubWorkloadCredentialSource, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const lock = yield* Semaphore.make(1)
    let cached: WorkloadCredential | undefined

    const acquire = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (cached && now < cached.renewAt) return cached
      // Discard old authority before attempting renewal. Failure cannot fall back.
      cached = undefined
      const { requestUrl, requestToken } = options.jobCapability()
      if (!requestUrl || !requestToken) {
        return yield* new WorkloadAuthenticationError({
          message: "GitHub Actions OIDC federation authentication requires a running job with id-token: write and ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN.",
        })
      }
      const url = yield* Effect.try({
        try: () => {
          const url = new URL(requestUrl)
          url.searchParams.set("audience", options.assertionAudience)
          return url.toString()
        },
        catch: () => new WorkloadAuthenticationError({ message: "Invalid GitHub token-request URL." }),
      })
      const assertionResponse = yield* http.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(requestToken)),
      ).pipe(Effect.mapError(() => new WorkloadAuthenticationError({ message: "GitHub assertion acquisition failed." })))
      if (assertionResponse.status !== 200) {
        return yield* new WorkloadAuthenticationError({ message: `GitHub assertion acquisition rejected (HTTP ${assertionResponse.status}).` })
      }
      const assertion: unknown = yield* assertionResponse.json.pipe(
        Effect.mapError(() => new WorkloadAuthenticationError({ message: "Invalid GitHub assertion response." })),
      )
      if (typeof assertion !== "object" || assertion === null || !("value" in assertion) || typeof assertion.value !== "string") {
        return yield* new WorkloadAuthenticationError({ message: "Missing GitHub assertion." })
      }
      // This is only an expiry hint. The issuer verifies the signature and trust.
      const assertionToken = assertion.value
      const assertionExpiry = yield* Effect.try({
        try: () => decodeJwt(assertionToken).exp,
        catch: () => new WorkloadAuthenticationError({ message: "Invalid GitHub assertion." }),
      })
      const exchangeStarted = yield* Clock.currentTimeMillis
      if (!assertionExpiry || assertionExpiry * 1000 <= exchangeStarted) {
        return yield* new WorkloadAuthenticationError({ message: "GitHub returned expired evidence; fresh evidence is required." })
      }
      const response = yield* http.execute(
        HttpClientRequest.post(options.tokenEndpoint).pipe(HttpClientRequest.bodyUrlParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
          subject_token: assertion.value,
          ...(options.clientId ? { client_id: options.clientId } : {}),
          ...(options.scope ? { scope: options.scope } : {}),
        })),
      ).pipe(Effect.mapError(() => new WorkloadAuthenticationError({ message: "Workload token exchange failed; no authentication fallback was attempted." })))
      if (response.status !== 200) {
        return yield* new WorkloadAuthenticationError({ message: `Workload token exchange rejected (HTTP ${response.status}); check effective trust. No authentication fallback was attempted.` })
      }
      const body: unknown = yield* response.json.pipe(
        Effect.mapError(() => new WorkloadAuthenticationError({ message: "Invalid workload token response." })),
      )
      if (typeof body !== "object" || body === null ||
          !("access_token" in body) || typeof body.access_token !== "string" ||
          !("expires_in" in body) || typeof body.expires_in !== "number" ||
          !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 5400 ||
          !("token_type" in body) || body.token_type !== "Bearer" || "refresh_token" in body) {
        return yield* new WorkloadAuthenticationError({ message: "Invalid workload token response or lifetime (maximum 90 minutes; no refresh token)." })
      }
      const accessToken = body.access_token
      const jwtExpiry = yield* Effect.try({
        try: () => decodeJwt(accessToken).exp,
        catch: () => new WorkloadAuthenticationError({ message: "Invalid workload access token." }),
      })
      const expiresAt = Math.min(exchangeStarted + body.expires_in * 1000, (jwtExpiry ?? 0) * 1000)
      const receivedAt = yield* Clock.currentTimeMillis
      if (!Number.isFinite(expiresAt) || expiresAt <= receivedAt) {
        return yield* new WorkloadAuthenticationError({ message: "Workload access token already expired." })
      }
      cached = {
        accessToken: body.access_token,
        expiresAt,
        renewAt: expiresAt - Math.min(60_000, (expiresAt - receivedAt) / 5),
      }
      return cached
    }).pipe(lock.withPermits(1))
    return { acquire }
  })
