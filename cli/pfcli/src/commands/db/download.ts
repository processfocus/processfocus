import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Console, Duration, Effect } from "effect"
import { CliError } from "../../errors"
import {
  graphqlRequest,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../../utils/remote-name-validation"
import { materializeTursoDbDownload } from "./tursodb-download"

const CREATE_DATABASE_DOWNLOAD_SESSION_MUTATION = `
  mutation CreateDatabaseDownloadSession($projectId: String!, $environmentId: String!) {
    createDatabaseDownloadSession(projectId: $projectId, environmentId: $environmentId) {
      databaseUrl
      authToken
      databaseName
      engine
      target {
        stageName
      }
    }
  }
`

const DOWNLOAD_WAIT_TIMEOUT_MS = 15 * 60 * 1000
interface CreateDatabaseDownloadSessionResponse {
  readonly createDatabaseDownloadSession: {
    readonly databaseUrl: string
    readonly authToken: string
    readonly databaseName: string
    readonly engine: "libsql" | "tursodb"
    readonly target: {
      readonly stageName: string
    }
  }
}

interface SyncDatabase {
  readonly pull: () => Promise<boolean>
  readonly close: () => Promise<void>
}

export interface SyncDatabaseOpts {
  readonly path: string
  readonly url: string
  readonly authToken: string
  readonly clientName: string
  readonly fetch: typeof fetch
}

type ConnectSyncDatabase = (opts: SyncDatabaseOpts) => Promise<SyncDatabase>

interface RunDownloadDbDependencies {
  readonly connectSyncDatabase?: ConnectSyncDatabase
  readonly fetch?: typeof fetch
  readonly now?: () => Date
  readonly syncPullTimeoutMs?: number
  readonly tursoDbDownloadTimeoutMs?: number
  readonly materializeTursoDbDownload?: typeof materializeTursoDbDownload
}

const sanitizeFilenamePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "target"

const formatTimestampForFilename = (date: Date): string =>
  date.toISOString().replace(/[:.]/g, "-")

const defaultDownloadOutputPath = (
  projectId: string,
  environmentId: string,
  now = new Date(),
): string =>
  `pfcli-db-${sanitizeFilenamePart(projectId)}-${sanitizeFilenamePart(
    environmentId,
  )}-${formatTimestampForFilename(now)}.sqlite`

const ensureOutputDirectoryExists = (
  resolvedOutputPath: string,
): Effect.Effect<void, CliError> => {
  const outputDir = dirname(resolvedOutputPath)

  return Effect.try({
    try: () => mkdirSync(outputDir, { recursive: true }),
    catch: (cause) =>
      new CliError({
        message: `Failed to create output directory: ${outputDir}`,
        cause,
      }),
  })
}

const closeSyncDatabase = (database: SyncDatabase): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => database.close(),
    catch: (cause) =>
      new CliError({
        message: "Failed to close local database sync state",
        cause,
      }),
  }).pipe(
    Effect.catchTag("CliError", (error) =>
      Console.error(`Warning: ${error.message}`),
    ),
  )

const pullDatabaseWithTursoSync = (input: {
  readonly databaseUrl: string
  readonly authToken: string
  readonly resolvedOutputPath: string
  readonly fetchImpl: typeof fetch
  readonly connectSyncDatabase: ConnectSyncDatabase
  readonly syncPullTimeoutMs: number
}): Effect.Effect<boolean, CliError> =>
  Effect.gen(function* () {
    const database = yield* Effect.tryPromise({
      try: () =>
        input.connectSyncDatabase({
          path: input.resolvedOutputPath,
          url: input.databaseUrl,
          authToken: input.authToken,
          clientName: "pfcli-db-download",
          fetch: input.fetchImpl,
        }),
      catch: () =>
        new CliError({
          message: "Failed to open local database sync state",
        }),
    })

    return yield* Effect.tryPromise({
      try: () => database.pull(),
      catch: () =>
        new CliError({
          message: "Database sync pull failed",
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(input.syncPullTimeoutMs),
        onTimeout: () =>
          new CliError({
            message: "Database sync pull timed out",
          }),
      }),
      Effect.ensuring(closeSyncDatabase(database)),
    )
  })

const ensureDownloadedFileExists = (
  resolvedOutputPath: string,
): Effect.Effect<void, CliError> =>
  Effect.sync(() => existsSync(resolvedOutputPath)).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.fail(
            new CliError({
              message: "Database sync completed without creating output file",
            }),
          ),
    ),
  )

const loadDefaultConnectSyncDatabase = (): Effect.Effect<
  ConnectSyncDatabase,
  CliError
> =>
  Effect.tryPromise({
    try: async () => {
      const { connect } = await import("@tursodatabase/sync")
      return connect as ConnectSyncDatabase
    },
    catch: (cause) =>
      new CliError({
        message: "Failed to load database sync support",
        cause,
      }),
  })

export const runDownloadDb = (
  projectId: string,
  environmentId: string,
  outputPath?: string,
  dependencies: RunDownloadDbDependencies = {},
): Effect.Effect<string, CliError> => {
  const now = dependencies.now ?? (() => new Date())
  const fetchImpl = dependencies.fetch ?? fetch
  const syncPullTimeoutMs =
    dependencies.syncPullTimeoutMs ?? DOWNLOAD_WAIT_TIMEOUT_MS
  const resolvedOutputPath = resolve(
    outputPath ?? defaultDownloadOutputPath(projectId, environmentId, now()),
  )

  return Effect.gen(function* () {
    yield* ensureKnownEnvironmentName(projectId, environmentId)

    const credentials = yield* readCredentialsOrFail()
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    yield* ensureOutputDirectoryExists(resolvedOutputPath)
    const syncingExistingOutput = yield* Effect.sync(() =>
      existsSync(resolvedOutputPath),
    )

    const session =
      yield* graphqlRequest<CreateDatabaseDownloadSessionResponse>(
        endpoint,
        credentials.accessToken,
        CREATE_DATABASE_DOWNLOAD_SESSION_MUTATION,
        { projectId, environmentId },
      ).pipe(Effect.map((response) => response.createDatabaseDownloadSession))

    const action =
      session.engine === "tursodb" && syncingExistingOutput
        ? "Replacing local snapshot"
        : syncingExistingOutput
          ? "Updating local copy"
          : "Downloading"
    yield* Console.log(
      `${action} ${session.databaseName} (${session.target.stageName})...`,
    )

    if (session.engine === "libsql") {
      const connectSyncDatabase =
        dependencies.connectSyncDatabase ??
        (yield* loadDefaultConnectSyncDatabase())

      yield* pullDatabaseWithTursoSync({
        databaseUrl: session.databaseUrl,
        authToken: session.authToken,
        resolvedOutputPath,
        fetchImpl,
        connectSyncDatabase,
        syncPullTimeoutMs,
      })
    } else {
      const materialize =
        dependencies.materializeTursoDbDownload ?? materializeTursoDbDownload
      yield* materialize({
        sourceUrl: session.databaseUrl,
        authToken: session.authToken,
        outputPath: resolvedOutputPath,
        fetch: fetchImpl,
        timeoutMs:
          dependencies.tursoDbDownloadTimeoutMs ?? DOWNLOAD_WAIT_TIMEOUT_MS,
      })
    }
    yield* ensureDownloadedFileExists(resolvedOutputPath)

    yield* Console.log(`Saved to ${resolvedOutputPath}`)

    return resolvedOutputPath
  })
}
