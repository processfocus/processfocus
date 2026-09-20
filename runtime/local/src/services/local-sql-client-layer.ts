import { Effect, Layer } from "effect"
import { DatabasePathConfig, isLocalFilePath } from "@pf/db-info"
import { makeTursoCloudLive } from "@pf/layer-turso-cloud"
import { makeTursoLive } from "@pf/layer-turso-local"

export const makeLocalSqlClientLayer = (options: {
  readonly busy_timeout: number
}) =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const databasePath = yield* DatabasePathConfig
      return isLocalFilePath(databasePath)
        ? makeTursoLive(options)
        : makeTursoCloudLive()
    }),
  )
