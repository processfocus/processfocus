import { PgClient } from "@effect/sql-pg"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Data, Effect, Layer, Redacted } from "effect"

export const POSTGRES_TEST_IMAGE = "postgres:15.14-alpine"

export class ContainerError extends Data.TaggedError("ContainerError")<{
  cause: unknown
}> {}

export class PgContainer extends Effect.Service<PgContainer>()(
  "@pf/service-drizzle-postgres/PgContainer",
  {
    scoped: Effect.acquireRelease(
      Effect.tryPromise({
        try: () => new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start(),
        catch: (cause) => new ContainerError({ cause }),
      }),
      (container) => Effect.promise(() => container.stop()),
    ),
  },
) {
  static ClientLive = Layer.unwrapEffect(
    Effect.gen(function* () {
      const container = yield* PgContainer
      // Add statement_timeout to connection URI to prevent tests hanging on locks
      // 5 second timeout catches issues quickly
      const uri = container.getConnectionUri()
      const uriWithTimeout = `${uri}?options=-c%20statement_timeout%3D5000`
      return PgClient.layer({
        url: Redacted.make(uriWithTimeout),
      })
    }),
  ).pipe(Layer.provide(this.Default))
}
