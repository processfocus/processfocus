import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Effect, type Redacted, Schema } from "effect"

const BalanceResponse = Schema.Struct({
  data: Schema.Struct({
    getProjectBalance: Schema.Struct({
      projectBalance: Schema.Number.pipe(Schema.finite()),
    }),
  }),
  // Even a partial GraphQL response with errors is an unreadable balance.
  errors: Schema.optional(Schema.Tuple()),
})

export interface ProjectBalanceAccess {
  readonly backendOrigin: string
  readonly projectId: string
  readonly credential: Redacted.Redacted<string>
}

export const makeProjectBalanceAdmission = (
  access: ProjectBalanceAccess,
): Effect.Effect<
  { readonly admits: Effect.Effect<boolean> },
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    )
    const admits = Effect.gen(function* () {
      const endpoint = yield* Effect.try(
        () => new URL("/graphql", access.backendOrigin).href,
      )
      const request = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bearerToken(access.credential),
        HttpClientRequest.setHeader("cache-control", "no-store"),
        HttpClientRequest.bodyJson({
          query:
            "query RuntimeProjectBalance($projectId: String!) { getProjectBalance(projectId: $projectId) { projectBalance } }",
          variables: { projectId: access.projectId },
        }),
      )
      const response = yield* client.execute(request)
      const balance =
        yield* HttpClientResponse.schemaBodyJson(BalanceResponse)(response)
      return balance.data.getProjectBalance.projectBalance > 0
    }).pipe(
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.catchAll(() =>
        Effect.logWarning(
          "Project Balance could not be read; admitting work",
        ).pipe(
          Effect.annotateLogs({
            projectId: access.projectId,
            backendOrigin: access.backendOrigin,
          }),
          Effect.as(true),
        ),
      ),
    )
    return { admits }
  })
