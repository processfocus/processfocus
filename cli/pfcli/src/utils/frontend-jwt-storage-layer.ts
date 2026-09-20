import type { SqlError } from "@effect/sql/SqlError"
import { Layer } from "effect"
import type { ConfigError } from "effect/ConfigError"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteOpenAuthStorageServiceLive } from "@pf/sqlite-operations"
import { makePfcliSqlClientLayer } from "./local-database-layer"

type FrontendJwtStorageService = Layer.Layer.Success<
  typeof SqliteOpenAuthStorageServiceLive
>

export const makeFrontendJwtStorageLayer = (
  databasePath: string,
): Layer.Layer<FrontendJwtStorageService, ConfigError | SqlError, never> => {
  const sqlClientLayer = makePfcliSqlClientLayer(databasePath)

  return SqliteOpenAuthStorageServiceLive.pipe(
    Layer.provideMerge(TypedSqliteDrizzleLayer),
    Layer.provideMerge(sqlClientLayer),
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )
}
