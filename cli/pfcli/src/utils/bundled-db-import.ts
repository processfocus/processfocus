import { Runtime } from "@processfocus/runtime"
import { ConfigProvider, DateTime, Effect, FiberRef, Layer } from "effect"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  LOCAL_SQLITE_BUSY_TIMEOUT_MS,
  isLocalFilePath,
  makeDatabaseConfigLayer,
  resolveDatabasePath,
} from "@pf/db-info"
import { TursoCloudLive } from "@pf/layer-turso-cloud"
import { storeOrganisation } from "@pf/org-to-db"
import { type Organisation, normalizePath } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteDbOperationsLive } from "@pf/sqlite-operations"
import { OrgLoadError } from "../errors"
import { validateFlows } from "./validate-flows"

const RequestTimeLive = Layer.effect(
  RequestTime,
  Effect.map(DateTime.now, (now) => FiberRef.unsafeMake(now)),
)

const loadTursoLayer = Effect.tryPromise({
  try: async () => {
    // Remote deploy imports must not load this native local-only dependency.
    // @tursodatabase/database has platform-specific native binaries and is
    // marked external in the org build. A static import would emit a
    // top-level require that AWS Lambda Docker images cannot resolve.
    const { makeTursoLive } = await import("@pf/layer-turso-local")
    return makeTursoLive({ busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS })
  },
  catch: (cause) => new OrgLoadError({ path: "<built-org>", cause }),
})

const loadTursoCloudLayer = Effect.succeed(TursoCloudLive)

export interface BundledDbImportResult {
  readonly orgName: string
  readonly processPaths: readonly string[]
}

interface BundledOrgModule {
  readonly configureOrg?: Effect.Effect<Organisation, unknown, never>
  readonly org?: Organisation
}

const resolveConfiguredOrganisation = (module: BundledOrgModule) => {
  if (module.configureOrg && Effect.isEffect(module.configureOrg)) {
    return module.configureOrg.pipe(
      Effect.provide(Layer.setConfigProvider(ConfigProvider.fromEnv())),
    )
  }

  if (module.org) {
    return Effect.succeed(module.org)
  }

  return Effect.fail(
    new OrgLoadError({
      path: "<built-org>",
      cause: new Error(
        "Built org bundle must export either 'configureOrg' or 'org'.",
      ),
    }),
  )
}

export const createBundledDbImport = (
  module: BundledOrgModule,
  orgPath?: string,
) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      return yield* new OrgLoadError({
        path: "<built-org>",
        cause: DATABASE_PATH_NOT_CONFIGURED,
      })
    }

    const org = yield* Runtime.loadOrganisation(
      { load: resolveConfiguredOrganisation },
      module,
    )

    yield* validateFlows(org).pipe(
      Effect.mapError(
        (error) =>
          new OrgLoadError({ path: "<built-org>", cause: error._tag ?? error }),
      ),
    )

    const dbLayer = isLocalFilePath(databasePath)
      ? yield* loadTursoLayer
      : yield* loadTursoCloudLayer
    const appLayer = Layer.mergeAll(
      SqliteDbOperationsLive,
      RequestTimeLive,
    ).pipe(
      Layer.provideMerge(TypedSqliteDrizzleLayer),
      Layer.provideMerge(dbLayer),
      Layer.provide(makeDatabaseConfigLayer(databasePath)),
    )

    yield* Runtime.hydrateOrganisation(
      {
        hydrate: (organisation) =>
          storeOrganisation(organisation).pipe(Effect.provide(appLayer)),
      },
      { transaction: (operation) => operation },
      org,
    )

    return {
      orgName: org.name,
      processPaths: org
        .processes()
        .map((process) => normalizePath(process.node.path)),
    } satisfies BundledDbImportResult
  })
