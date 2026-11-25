import { Layer } from "effect"
import { LocalAuditLive } from "@pf/audit/local"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteAuditPersistenceLive } from "@pf/sqlite-operations/authentication"
import { makeLocalSqlClientLayer } from "./local-sql-client-layer"

/** Independent connection: never inherit the surrounding request's transaction. */
export const LocalRuntimeAuditLive = LocalAuditLive.pipe(
  Layer.provideMerge(SqliteAuditPersistenceLive),
  Layer.provide(
    TypedSqliteDrizzleLayer.pipe(
      Layer.fresh,
      Layer.provideMerge(
        makeLocalSqlClientLayer({
          busy_timeout: 25,
          defaultQueryTimeout: 100,
        }),
      ),
    ),
  ),
)
