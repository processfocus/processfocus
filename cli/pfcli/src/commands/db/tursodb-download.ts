import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  TURSO_LOGICAL_DUMP_PREFIX_INSPECT_BYTES,
  TURSO_LOGICAL_DUMP_SUFFIX_INSPECT_BYTES,
  filterTursoInternalStatements,
  httpsDumpUrlFromTursoLibsqlUrl,
  isPlausibleTursoSqlDumpPrefix,
  isPlausibleTursoSqlDumpSuffix,
} from "@processfocus/hosting-contract"
import { Cause, Data, Duration, Effect, Exit } from "effect"
import { CliError } from "../../errors"
import { Database } from "bun:sqlite"

const DEFAULT_TURSODB_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000
const TURSO_INTERNAL_OBJECT_GLOB = "__turso_internal_*"

interface TursoSchemaObject {
  readonly type: "index" | "table" | "trigger" | "view"
  readonly name: string
}

interface IntegrityCheckRow {
  readonly integrity_check: string
}

interface ForeignKeyCheckRow {
  readonly table: string
  readonly rowid: number | null
  readonly parent: string
  readonly fkid: number
}

interface SanitizedBoundaryCause {
  readonly _tag: "SanitizedBoundaryCause"
  readonly errorType:
    | "DOMException"
    | "Error"
    | "NonErrorObject"
    | "NonErrorPrimitive"
    | "RangeError"
    | "TypeError"
  readonly code?: string | number
}

class TursoDbDownloadFailure extends Data.TaggedError(
  "TursoDbDownloadFailure",
)<{
  readonly message: string
  readonly cause?: SanitizedBoundaryCause
}> {}

interface WriteAllBytesInput {
  readonly bytes: Uint8Array
  readonly write: (
    bytes: Uint8Array,
    offset: number,
    length: number,
    signal: AbortSignal,
  ) => Promise<{ readonly bytesWritten: number }>
}

interface DumpReader {
  readonly cancel: () => Promise<void>
  readonly releaseLock: () => void
}

interface CloseableFile {
  readonly close: () => Promise<void>
}

interface DumpFile extends CloseableFile {
  readonly sync: () => Promise<void>
  readonly write: (
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ readonly bytesWritten: number }>
}

const SAFE_BOUNDARY_ERROR_CODES = new Set([
  "EACCES",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDQUOT",
  "EEXIST",
  "EIO",
  "ENOENT",
  "ENOSPC",
  "EPIPE",
  "ETIMEDOUT",
  "SQLITE_BUSY",
  "SQLITE_CONSTRAINT",
  "SQLITE_CORRUPT",
  "SQLITE_ERROR",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  "UND_ERR_CONNECT_TIMEOUT",
])

export interface MaterializeTursoDbDownloadInput {
  readonly sourceUrl: string
  readonly authToken: string
  readonly outputPath: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

const safeBoundaryErrorCode = (cause: unknown): string | number | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }

  const code = cause.code
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    return code
  }
  if (typeof code === "string" && SAFE_BOUNDARY_ERROR_CODES.has(code)) {
    return code
  }
  return undefined
}

const sanitizeBoundaryCause = (cause: unknown): SanitizedBoundaryCause => {
  const errorType =
    cause instanceof DOMException
      ? "DOMException"
      : cause instanceof TypeError
        ? "TypeError"
        : cause instanceof RangeError
          ? "RangeError"
          : cause instanceof Error
            ? "Error"
            : typeof cause === "object" && cause !== null
              ? "NonErrorObject"
              : "NonErrorPrimitive"
  const code = safeBoundaryErrorCode(cause)

  return code === undefined
    ? { _tag: "SanitizedBoundaryCause", errorType }
    : { _tag: "SanitizedBoundaryCause", errorType, code }
}

const downloadFailure = (
  message: string,
  cause?: unknown,
): TursoDbDownloadFailure =>
  new TursoDbDownloadFailure(
    cause === undefined
      ? { message }
      : { message, cause: sanitizeBoundaryCause(cause) },
  )

const tryBoundary = <A>(input: {
  readonly message: string
  readonly try: () => A
}): Effect.Effect<A, TursoDbDownloadFailure> =>
  Effect.try({
    try: input.try,
    catch: (cause) => downloadFailure(input.message, cause),
  })

const tryBoundaryPromise = <A>(input: {
  readonly message: string
  readonly try: (signal: AbortSignal) => PromiseLike<A>
}): Effect.Effect<A, TursoDbDownloadFailure> =>
  Effect.tryPromise({
    try: input.try,
    catch: (cause) => downloadFailure(input.message, cause),
  })

const effectFromExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isFailure(exit)
    ? Effect.failCause(exit.cause)
    : Effect.succeed(exit.value)

const acquireUseReleaseWithFailure = <A, E, R, A2, E2, R2, E3, R3>(
  acquire: Effect.Effect<A, E, R>,
  use: (resource: A) => Effect.Effect<A2, E2, R2>,
  release: (
    resource: A,
    useExit: Exit.Exit<A2, E2>,
  ) => Effect.Effect<void, E3, R3>,
): Effect.Effect<A2, E | E2 | E3, R | R2 | R3> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const resource = yield* acquire
      const useExit = yield* Effect.exit(restore(use(resource)))
      const releaseExit = yield* Effect.exit(release(resource, useExit))
      if (Exit.isFailure(releaseExit)) {
        if (Exit.isFailure(useExit)) {
          return yield* Effect.failCause(
            Cause.sequential(useExit.cause, releaseExit.cause),
          )
        }
        return yield* Effect.failCause(releaseExit.cause)
      }
      return yield* effectFromExit(useExit)
    }),
  )

const mapDownloadFailureCauseToCliError = (
  cause: Cause.Cause<TursoDbDownloadFailure>,
): Cause.Cause<CliError> =>
  Cause.map(
    cause,
    (error) => new CliError({ message: error.message, cause: error }),
  )

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`

/** @internal Completes partial writes before the caller publishes a dump. */
export const writeAllBytes = (
  input: WriteAllBytesInput,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    let offset = 0
    while (offset < input.bytes.byteLength) {
      const { bytesWritten } = yield* tryBoundaryPromise({
        message: "Failed to write complete TursoDB dump response",
        try: (signal) =>
          input.write(
            input.bytes,
            offset,
            input.bytes.byteLength - offset,
            signal,
          ),
      })
      if (
        !Number.isSafeInteger(bytesWritten) ||
        bytesWritten < 1 ||
        bytesWritten > input.bytes.byteLength - offset
      ) {
        yield* Effect.fail(
          downloadFailure("Failed to write complete TursoDB dump response"),
        )
      }
      offset += bytesWritten
    }
  })

const closeFile = (
  handle: CloseableFile,
  message: string,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundaryPromise({
    message,
    try: () => handle.close(),
  })

const closeFileAfterUse = (input: {
  readonly handle: CloseableFile
  readonly message: string
  readonly useExit: Exit.Exit<unknown, unknown>
}): Effect.Effect<void, TursoDbDownloadFailure> =>
  Exit.isInterrupted(input.useExit)
    ? tryBoundary({
        message: input.message,
        try: () => {
          void input.handle.close().catch(() => undefined)
        },
      })
    : closeFile(input.handle, input.message)

const readDumpBoundarySamples = (
  dumpPath: string,
): Effect.Effect<
  {
    readonly byteSize: number
    readonly firstBytes: Uint8Array
    readonly lastBytes: Uint8Array
  },
  TursoDbDownloadFailure
> =>
  Effect.gen(function* () {
    const { size } = yield* tryBoundaryPromise({
      message: "Failed to inspect TursoDB dump response",
      try: () => stat(dumpPath),
    })
    const firstLength = Math.min(size, TURSO_LOGICAL_DUMP_PREFIX_INSPECT_BYTES)
    const lastLength = Math.min(size, TURSO_LOGICAL_DUMP_SUFFIX_INSPECT_BYTES)
    const firstBytes = new Uint8Array(firstLength)
    const lastBytes = new Uint8Array(lastLength)

    yield* acquireUseReleaseWithFailure(
      tryBoundaryPromise({
        message: "Failed to inspect TursoDB dump response",
        try: () => open(dumpPath, "r"),
      }),
      (handle) =>
        Effect.gen(function* () {
          if (firstLength > 0) {
            yield* tryBoundaryPromise({
              message: "Failed to inspect TursoDB dump response",
              try: () => handle.read(firstBytes, 0, firstLength, 0),
            })
            yield* tryBoundaryPromise({
              message: "Failed to inspect TursoDB dump response",
              try: () =>
                handle.read(lastBytes, 0, lastLength, size - lastLength),
            })
          }
        }),
      (handle) =>
        closeFile(handle, "Failed to publish downloaded TursoDB snapshot"),
    )

    return { byteSize: size, firstBytes, lastBytes }
  })

const cancelResponseBody = (
  body: ReadableStream<Uint8Array>,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundaryPromise({
    message: "TursoDB dump request failed",
    try: () => body.cancel(),
  })

const cancelReader = (
  reader: DumpReader,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundary({
    message: "TursoDB dump request failed",
    try: () => {
      void reader.cancel().catch(() => undefined)
    },
  })

const releaseReaderLock = (
  reader: DumpReader,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundary({
    message: "TursoDB dump request failed",
    try: () => reader.releaseLock(),
  })

const abortRequestOnInterruptionSignal = (
  signal: AbortSignal,
  controller: AbortController,
): void => {
  signal.addEventListener("abort", () => controller.abort(), { once: true })
}

/** @internal Streams a dump with injectable file operations for verification. */
export const streamDumpToPrivateFile = (input: {
  readonly sourceUrl: string
  readonly authToken: string
  readonly dumpPath: string
  readonly fetchImpl: typeof fetch
  readonly openDumpFile: (dumpPath: string) => Promise<DumpFile>
  readonly timeoutMs: number
}): Effect.Effect<void, TursoDbDownloadFailure> => {
  const controller = new AbortController()

  const streamDump = Effect.gen(function* () {
    const dumpUrl = yield* tryBoundary({
      message: "Database Download session returned an invalid database URL",
      try: () => httpsDumpUrlFromTursoLibsqlUrl(input.sourceUrl),
    })
    const response = yield* tryBoundaryPromise({
      message: "TursoDB dump request failed",
      try: (signal) => {
        abortRequestOnInterruptionSignal(signal, controller)
        return input.fetchImpl(dumpUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${input.authToken}` },
          signal: controller.signal,
        })
      },
    })

    if (!response.ok) {
      if (response.body !== null) {
        yield* cancelResponseBody(response.body).pipe(Effect.ignore)
      }
      yield* Effect.fail(
        downloadFailure(
          `TursoDB dump request failed with HTTP ${response.status}`,
        ),
      )
    }
    const responseBody = response.body
    if (responseBody === null) {
      return yield* Effect.fail(
        downloadFailure("TursoDB dump response was empty"),
      )
    }

    yield* acquireUseReleaseWithFailure(
      tryBoundary({
        message: "TursoDB dump request failed",
        try: () => responseBody.getReader(),
      }),
      (activeReader) =>
        acquireUseReleaseWithFailure(
          tryBoundaryPromise({
            message: "TursoDB dump request failed",
            try: (signal) => {
              abortRequestOnInterruptionSignal(signal, controller)
              return input.openDumpFile(input.dumpPath)
            },
          }),
          (dumpFile) =>
            Effect.gen(function* () {
              while (true) {
                const next = yield* tryBoundaryPromise({
                  message: "TursoDB dump request failed",
                  try: (signal) => {
                    abortRequestOnInterruptionSignal(signal, controller)
                    return activeReader.read()
                  },
                })
                if (next.done) {
                  break
                }
                if (next.value.byteLength > 0) {
                  yield* writeAllBytes({
                    bytes: next.value,
                    write: (bytes, offset, length, signal) => {
                      abortRequestOnInterruptionSignal(signal, controller)
                      return dumpFile.write(bytes, offset, length, null)
                    },
                  })
                }
              }
              yield* tryBoundaryPromise({
                message: "TursoDB dump request failed",
                try: (signal) => {
                  abortRequestOnInterruptionSignal(signal, controller)
                  return dumpFile.sync()
                },
              })
            }),
          (dumpFile, useExit) =>
            closeFileAfterUse({
              handle: dumpFile,
              message: "TursoDB dump request failed",
              useExit,
            }),
        ),
      (activeReader) =>
        Effect.gen(function* () {
          yield* cancelReader(activeReader).pipe(Effect.ignore)
          yield* releaseReaderLock(activeReader)
        }),
    )
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        controller.abort()
      }),
    ),
  )

  return streamDump.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(input.timeoutMs),
      onTimeout: () => downloadFailure("TursoDB dump request timed out"),
    }),
  )
}

const validateDumpStructure = (
  dumpPath: string,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    const sample = yield* readDumpBoundarySamples(dumpPath)
    if (sample.byteSize === 0) {
      yield* Effect.fail(downloadFailure("TursoDB dump response was empty"))
    }
    if (!isPlausibleTursoSqlDumpPrefix(sample.firstBytes)) {
      yield* Effect.fail(
        downloadFailure("TursoDB dump response was not valid logical SQL"),
      )
    }
    if (!isPlausibleTursoSqlDumpSuffix(sample.lastBytes)) {
      yield* Effect.fail(
        downloadFailure("TursoDB dump response was truncated or malformed"),
      )
    }
  })

const removeResidualTursoObjects = (
  database: Database,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    const objects = yield* tryBoundary({
      message: "Failed to materialize TursoDB logical dump as SQLite",
      try: () =>
        database
          .query<TursoSchemaObject, []>(
            `SELECT type, name
             FROM sqlite_schema
             WHERE name GLOB '${TURSO_INTERNAL_OBJECT_GLOB}'
             ORDER BY CASE type
               WHEN 'trigger' THEN 1
               WHEN 'index' THEN 2
               WHEN 'view' THEN 3
               WHEN 'table' THEN 4
               ELSE 5
             END`,
          )
          .all(),
    })

    for (const object of objects) {
      const name = quoteIdentifier(object.name)
      yield* tryBoundary({
        message: "Failed to materialize TursoDB logical dump as SQLite",
        try: () => {
          switch (object.type) {
            case "trigger":
              database.exec(`DROP TRIGGER ${name}`)
              break
            case "index":
              database.exec(`DROP INDEX ${name}`)
              break
            case "view":
              database.exec(`DROP VIEW ${name}`)
              break
            case "table":
              database.exec(`DROP TABLE ${name}`)
              break
            default: {
              const unexpectedType: never = object.type
              throw new Error(
                `Unexpected Turso schema object type: ${String(unexpectedType)}`,
              )
            }
          }
        },
      })
    }

    const remaining = yield* tryBoundary({
      message: "Failed to materialize TursoDB logical dump as SQLite",
      try: () =>
        database
          .query<{ readonly name: string }, []>(
            `SELECT name FROM sqlite_schema WHERE name GLOB '${TURSO_INTERNAL_OBJECT_GLOB}'`,
          )
          .all(),
    })
    if (remaining.length > 0) {
      yield* Effect.fail(
        downloadFailure(
          "TursoDB internal objects remained after logical replay",
        ),
      )
    }
  })

const validateOpenDatabase = (
  database: Database,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    const integrity = yield* tryBoundary({
      message: "Downloaded TursoDB snapshot failed PRAGMA integrity_check",
      try: () =>
        database.query<IntegrityCheckRow, []>("PRAGMA integrity_check").all(),
    })
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      yield* Effect.fail(
        downloadFailure(
          "Downloaded TursoDB snapshot failed PRAGMA integrity_check",
        ),
      )
    }

    const foreignKeyViolations = yield* tryBoundary({
      message: "Downloaded TursoDB snapshot failed PRAGMA foreign_key_check",
      try: () =>
        database
          .query<ForeignKeyCheckRow, []>("PRAGMA foreign_key_check")
          .all(),
    })
    if (foreignKeyViolations.length > 0) {
      yield* Effect.fail(
        downloadFailure(
          "Downloaded TursoDB snapshot failed PRAGMA foreign_key_check",
        ),
      )
    }
  })

const closeDatabase = (input: {
  readonly database: Database
  readonly message: string
}): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundary({
    message: input.message,
    try: () => input.database.close(),
  })

const validateDatabaseFile = (
  databasePath: string,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  acquireUseReleaseWithFailure(
    tryBoundary({
      message: "Downloaded TursoDB snapshot failed PRAGMA integrity_check",
      try: () => new Database(databasePath, { readonly: true, strict: true }),
    }),
    validateOpenDatabase,
    (database) =>
      closeDatabase({
        database,
        message: "Downloaded TursoDB snapshot failed validation",
      }),
  )

export const validateTursoDbDownloadArtifact = (
  databasePath: string,
): Effect.Effect<void, CliError> =>
  validateDatabaseFile(databasePath).pipe(
    Effect.mapErrorCause(mapDownloadFailureCauseToCliError),
  )

const replayLogicalDump = (input: {
  readonly dumpPath: string
  readonly databasePath: string
}): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    const dump = yield* tryBoundaryPromise({
      message: "Failed to materialize TursoDB logical dump as SQLite",
      try: () => readFile(input.dumpPath, "utf8"),
    })
    const filteredDump = yield* tryBoundary({
      message: "Failed to materialize TursoDB logical dump as SQLite",
      try: () => filterTursoInternalStatements(dump),
    })

    yield* acquireUseReleaseWithFailure(
      tryBoundary({
        message: "Failed to create private TursoDB snapshot staging file",
        try: () =>
          new Database(input.databasePath, {
            create: true,
            strict: true,
          }),
      }),
      (database) =>
        Effect.gen(function* () {
          yield* tryBoundaryPromise({
            message: "Failed to create private TursoDB snapshot staging file",
            try: () => chmod(input.databasePath, 0o600),
          })
          yield* tryBoundary({
            message: "Failed to materialize TursoDB logical dump as SQLite",
            try: () => {
              database.exec("PRAGMA journal_mode = DELETE")
              database.exec(filteredDump)
            },
          })
          yield* removeResidualTursoObjects(database)
          yield* validateOpenDatabase(database)
        }),
      (database) =>
        closeDatabase({
          database,
          message: "Failed to publish downloaded TursoDB snapshot",
        }),
    )

    yield* validateDatabaseFile(input.databasePath)
  })

const syncFile = (path: string): Effect.Effect<void, TursoDbDownloadFailure> =>
  acquireUseReleaseWithFailure(
    tryBoundaryPromise({
      message: "Failed to publish downloaded TursoDB snapshot",
      try: () => open(path, "r"),
    }),
    (handle) =>
      tryBoundaryPromise({
        message: "Failed to publish downloaded TursoDB snapshot",
        try: () => handle.sync(),
      }),
    (handle) =>
      closeFile(handle, "Failed to publish downloaded TursoDB snapshot"),
  )

const removeStagingDirectory = (
  stagingDirectory: string,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  tryBoundaryPromise({
    message: "Failed to materialize TursoDB snapshot",
    try: () => rm(stagingDirectory, { recursive: true, force: true }),
  })

const materialize = (
  input: MaterializeTursoDbDownloadInput,
): Effect.Effect<void, TursoDbDownloadFailure> =>
  Effect.gen(function* () {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TURSODB_DOWNLOAD_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      yield* Effect.fail(
        downloadFailure("TursoDB download timeout must be a positive integer"),
      )
    }

    const outputDirectory = dirname(input.outputPath)
    yield* acquireUseReleaseWithFailure(
      tryBoundaryPromise({
        message: "Failed to publish downloaded TursoDB snapshot",
        try: () =>
          mkdtemp(
            join(outputDirectory, `.${basename(input.outputPath)}.download-`),
          ),
      }),
      (activeStagingDirectory) =>
        Effect.gen(function* () {
          const dumpPath = join(activeStagingDirectory, "source.sql")
          const databasePath = join(activeStagingDirectory, "snapshot.sqlite")

          yield* tryBoundaryPromise({
            message: "Failed to publish downloaded TursoDB snapshot",
            try: () => chmod(activeStagingDirectory, 0o700),
          })
          yield* streamDumpToPrivateFile({
            sourceUrl: input.sourceUrl,
            authToken: input.authToken,
            dumpPath,
            fetchImpl: input.fetch ?? fetch,
            openDumpFile: (path) => open(path, "wx", 0o600),
            timeoutMs,
          })
          yield* validateDumpStructure(dumpPath)
          yield* replayLogicalDump({ dumpPath, databasePath })
          yield* syncFile(databasePath)
          yield* tryBoundaryPromise({
            message: "Failed to publish downloaded TursoDB snapshot",
            try: () => rename(databasePath, input.outputPath),
          })
        }),
      removeStagingDirectory,
    )
  })

export const materializeTursoDbDownload = (
  input: MaterializeTursoDbDownloadInput,
): Effect.Effect<void, CliError> =>
  materialize(input).pipe(
    Effect.mapErrorCause(mapDownloadFailureCauseToCliError),
  )
