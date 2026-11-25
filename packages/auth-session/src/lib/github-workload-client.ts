import { Effect, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
  WorkloadAuthenticationError,
  type WorkloadCredential,
  createGitHubWorkloadCredentialSource,
} from "@pf/openauth/github-workload"

interface WorkloadSessionSource {
  readonly acquire: (
    scope?: string,
  ) => Effect.Effect<WorkloadCredential, WorkloadAuthenticationError>
}

/** Job-side sessions only. Browser cookies receive access, never GitHub capability.
 * Call acquire before sending work; an authentication failure is never a reason
 * to replay a business mutation or fall back to client credentials.
 */
export const createWorkloadSessionSource = (
  options: Parameters<typeof createGitHubWorkloadCredentialSource>[0] & {
    readonly graphqlEndpoint: string
  },
): Effect.Effect<WorkloadSessionSource, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const machine = yield* createGitHubWorkloadCredentialSource(options)
    const http = yield* HttpClient.HttpClient
    const lock = yield* Semaphore.make(1)
    const sessions = new Map<string, WorkloadCredential>()
    const acquire = (
      scope?: string,
    ): Effect.Effect<WorkloadCredential, WorkloadAuthenticationError> =>
      Effect.gen(function* () {
        if (scope && !scope.startsWith("role:"))
          return yield* new WorkloadAuthenticationError({
            message: "Unsupported workload scope",
          })
        const parent = yield* machine.acquire
        if (!scope) return parent
        const cached = sessions.get(scope)
        // Scoped sessions inherit the parent's renewal deadline. Let its cache
        // decide renewal once: a second clock read can cross renewAt and try to
        // exchange the nearly expired parent that was just accepted above.
        if (cached && cached.expiresAt === parent.expiresAt) return cached
        sessions.delete(scope)
        const value = yield* Effect.try({
          try: () => decodeURIComponent(scope.slice(5)),
          catch: () =>
            new WorkloadAuthenticationError({
              message: "Invalid workload scope",
            }),
        })
        const permission = yield* http.execute(
          HttpClientRequest.post(options.graphqlEndpoint).pipe(
            HttpClientRequest.bearerToken(parent.accessToken),
            HttpClientRequest.bodyJsonUnsafe({
              query:
                "mutation($value: String!) { requestRole(rolePath: $value) { success } }",
              variables: { value },
            }),
          ),
        )
        const body = yield* permission.json
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              requestRole: Schema.Struct({ success: Schema.Boolean }),
            }),
          }),
        )(body)
        if (permission.status !== 200 || !parsed.data.requestRole.success)
          return yield* new WorkloadAuthenticationError({
            message: "Workload permission denied",
          })
        const response = yield* http.execute(
          HttpClientRequest.post(options.tokenEndpoint).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token_type:
                "urn:ietf:params:oauth:token-type:access_token",
              subject_token: parent.accessToken,
              scope,
            }),
          ),
        )
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            access_token: Schema.String,
            expires_in: Schema.Number,
            refresh_token: Schema.optional(Schema.Never),
          }),
        )(yield* response.json)
        if (response.status !== 200 || result.expires_in <= 0)
          return yield* new WorkloadAuthenticationError({
            message: "Workload scope exchange rejected",
          })
        const credential = { ...parent, accessToken: result.access_token }
        sessions.set(scope, credential)
        return credential
      }).pipe(
        Effect.mapError(
          () =>
            new WorkloadAuthenticationError({
              message:
                "Workload session acquisition failed; no secret fallback attempted",
            }),
        ),
        lock.withPermits(1),
      )
    return { acquire }
  })
