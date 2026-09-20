import type * as Client from "@effect/sql/SqlClient"
import { SqlError } from "@effect/sql/SqlError"
import { Effect, Layer } from "effect"
import type { ConfigError } from "effect/ConfigError"
import {
  type DatabaseConnectionInfo,
  LOCAL_SQLITE_BUSY_TIMEOUT_MS,
  isLocalFilePath,
} from "@pf/db-info"

type PfcliDatabaseLayer = Layer.Layer<
  Client.SqlClient | DatabaseConnectionInfo,
  ConfigError | SqlError,
  never
>

interface PfcliDatabaseLayerLoaders {
  readonly cloud: () => Promise<PfcliDatabaseLayer>
  readonly local: () => Promise<PfcliDatabaseLayer>
}

const loadLayer = (
  load: () => Promise<PfcliDatabaseLayer>,
  message: string,
): PfcliDatabaseLayer =>
  Layer.unwrapEffect(
    Effect.tryPromise({
      try: load,
      catch: (cause) =>
        new SqlError({
          cause,
          message,
        }),
    }),
  )

const defaultLoaders: PfcliDatabaseLayerLoaders = {
  local: async () => {
    // Remote deploy imports must not load this native local-only dependency.
    const { makeTursoLive } = await import("@pf/layer-turso-local")
    return makeTursoLive({ busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS })
  },
  cloud: async () => {
    const { TursoCloudLive } = await import("@pf/layer-turso-cloud")
    return TursoCloudLive as PfcliDatabaseLayer
  },
}

const TursoLocalLive = (loaders: PfcliDatabaseLayerLoaders) =>
  loadLayer(loaders.local, "Failed to load local Turso database layer")

const TursoCloudLive = (loaders: PfcliDatabaseLayerLoaders) =>
  loadLayer(loaders.cloud, "Failed to load Turso Cloud database layer")

export const makePfcliSqlClientLayer = (
  databasePath: string,
  loaders: PfcliDatabaseLayerLoaders = defaultLoaders,
) =>
  (isLocalFilePath(databasePath)
    ? TursoLocalLive(loaders)
    : TursoCloudLive(loaders)) satisfies PfcliDatabaseLayer
