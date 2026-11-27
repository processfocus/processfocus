import { Layer, ManagedRuntime } from "effect"
import { makeMcpOAuthStorageRoute } from "@pf/graphql-api"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteMcpOAuthRecordsLive } from "@pf/sqlite-operations"

export async function startMcpOAuthStorage(secret: string) {
  const runtime = ManagedRuntime.make(
    SqliteMcpOAuthRecordsLive.pipe(Layer.provide(DatabaseTest)),
  )
  const route = await runtime.runPromise(makeMcpOAuthStorageRoute(secret))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const result = route(request)
      return result
        ? runtime.runPromise(result)
        : new Response(null, { status: 404 })
    },
  })
  return {
    origin: server.url.origin,
    async stop() {
      await server.stop(true)
      await runtime.dispose()
    },
  }
}
