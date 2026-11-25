import { ConfigProvider, DateTime, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { UserDetails } from "@pf/graphql-db-operations"
import { makeTursoLive } from "@pf/layer-turso-local"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"

export const supervisedQueueLayer = (path: string) => {
  const sql = makeTursoLive().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: path }),
      ),
    ),
  )
  return SqliteQueueServiceLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TypedSqliteDrizzleLayer.pipe(Layer.provideMerge(sql)),
        Layer.succeed(RequestTime, DateTime.makeUnsafe(0)),
        Layer.succeed(UserDetails, { by: "TEST", id: "test" }),
      ),
    ),
  )
}

export const createSupervisedQueueTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE pf_job_queue (
    id TEXT PRIMARY KEY NOT NULL, queue TEXT NOT NULL, job_payload TEXT NOT NULL,
    job_attempts INTEGER NOT NULL DEFAULT 0, job_retry_limit INTEGER NOT NULL DEFAULT 5,
    available_at REAL NOT NULL, locked_until REAL, claim_receipt TEXT,
    terminal_at REAL, terminal_reason TEXT, terminal_outcome TEXT, redriven_from TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL, created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0
  )`
})
