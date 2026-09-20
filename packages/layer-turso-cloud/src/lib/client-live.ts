import * as Reactivity from "@effect/experimental/Reactivity"
import * as Client from "@effect/sql/SqlClient"
import type { Connection as SqlConnection } from "@effect/sql/SqlConnection"
import { SqlError } from "@effect/sql/SqlError"
import * as Statement from "@effect/sql/Statement"
import { Session as TursoSession } from "@tursodatabase/serverless"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/ConfigError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberRef from "effect/FiberRef"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  DatabaseConnectionInfo,
  DatabasePathConfig,
  causeChainIncludes,
  concurrentTransactionCommitError,
  concurrentTransactionRequested,
  isSqlLockError,
  isSqlWriteWriteConflictError,
  normalizeDatabasePath,
  transactionMode,
} from "@pf/db-info"

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const TURSO_LOCK_MAX_RETRIES = 5
const TURSO_LOCK_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2).pipe(
  Schedule.intersect(Schedule.recurs(TURSO_LOCK_MAX_RETRIES)),
  Schedule.jittered,
)
const isRetryableSqlLockError = (error: unknown): boolean =>
  isSqlLockError(error) && !isSqlWriteWriteConflictError(error)

const AuthTokenConfig = Config.redacted("TURSO_AUTH_TOKEN").pipe(
  Config.orElse(() => Config.succeed(undefined)),
)
const ConcurrentTransactionsConfig = Config.string("TURSO_CONCURRENT_TX").pipe(
  Config.map((value) => value === "1"),
  Config.orElse(() => Config.succeed(false)),
)

const ConnectionInfoLayer = Layer.effect(
  DatabaseConnectionInfo,
  DatabasePathConfig.pipe(Config.map(normalizeDatabasePath)),
)

const TursoCloudTransaction = Context.GenericTag<
  readonly [TursoCloudConnection, counter: number]
>("@pf/layer-turso-cloud/TursoCloudTransaction")

export class TursoCloudBatch extends Context.Tag(
  "@pf/layer-turso-cloud/TursoCloudBatch",
)<
  TursoCloudBatch,
  {
    /** Executes all statements atomically, with an explicit foreign-key policy. */
    readonly execute: (input: {
      readonly statements: ReadonlyArray<string>
      readonly foreignKeys: "enforced" | "disabled-during-batch"
    }) => Effect.Effect<void, SqlError>
  }
>() {}

interface TursoCloudClientServices {
  readonly batch: TursoCloudBatch["Type"]
  readonly client: Client.SqlClient
}

type SqlAttempt =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly cause: SqlError }

interface TursoCloudConnection extends SqlConnection {
  readonly beginTransaction: Effect.Effect<TursoCloudConnection, SqlError>
  readonly commit: Effect.Effect<void, SqlError>
  readonly rollback: Effect.Effect<void, SqlError>
}

type TursoValue =
  | null
  | string
  | number
  | bigint
  | ArrayBuffer
  | boolean
  | Uint8Array
  | Date

interface TursoRow {
  readonly length: number
  readonly [index: number]: TursoValue
}

interface ServerlessResultSet {
  readonly columns: ReadonlyArray<string>
  readonly columnTypes?: ReadonlyArray<string>
  readonly rows: ReadonlyArray<TursoRow>
  readonly rowsAffected?: number
  readonly lastInsertRowid?: number | bigint
}

interface TursoResultSet {
  readonly columns: ReadonlyArray<string>
  readonly columnTypes: ReadonlyArray<string>
  readonly rows: ReadonlyArray<TursoRow>
  readonly rowsAffected: number
  readonly lastInsertRowid: bigint | undefined
}

export interface TursoCloudClientOptions {
  readonly deferredTransactions?: boolean
  readonly authToken?: Redacted.Redacted<string>
  readonly refreshAuthToken?: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    never,
    never
  >
}

const resultRows = (result: TursoResultSet) =>
  result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
  )

const resultValues = (result: TursoResultSet) => result.rows

const normalizeResultSet = (result: ServerlessResultSet): TursoResultSet => {
  const lastInsertRowid =
    result.lastInsertRowid === undefined
      ? undefined
      : typeof result.lastInsertRowid === "bigint"
        ? result.lastInsertRowid
        : BigInt(result.lastInsertRowid)

  return {
    columns: Array.from(result.columns),
    columnTypes: Array.from(result.columnTypes ?? []),
    rows: Array.from(result.rows),
    rowsAffected: result.rowsAffected ?? 0,
    lastInsertRowid,
  }
}

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code
    const codeText = typeof code === "string" ? ` ${code}` : ""
    const nested = cause.cause
      ? `; caused by ${describeCause(cause.cause)}`
      : ""

    return `${cause.name}${codeText}: ${cause.message}${nested}`
  }

  return String(cause)
}

const TURSO_READS_BLOCKED_HINT =
  "Turso blocked SQL reads; a database organization plan limit may be responsible - check Turso usage and plan settings"

const isTursoReadsBlocked = (cause: unknown): boolean =>
  causeChainIncludes(
    cause,
    (message) =>
      message.includes("SQL read operations are forbidden") ||
      message.includes("reads are blocked"),
  )

const makeSqlError = (message: string, cause: unknown) =>
  new SqlError({
    cause: new Error(`${message}: ${describeCause(cause)}`, { cause }),
    message: isTursoReadsBlocked(cause)
      ? `${message} (${TURSO_READS_BLOCKED_HINT})`
      : message,
  })

const isHttpNotFound = (cause: unknown): boolean =>
  causeChainIncludes(cause, (message) =>
    message.includes("HTTP error! status: 404"),
  )

// Session preserves complete result sets; the semaphore protects its single Hrana baton.
interface TursoSdk {
  readonly session: TursoSession
  readonly semaphore: Effect.Semaphore
}

const closeSession = (sdk: TursoSdk): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => sdk.session.close(),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((e) =>
      Effect.logWarning("Failed to close Turso connection", Cause.fail(e)),
    ),
  )

const closeSdk = (sdk: TursoSdk): Effect.Effect<void, never> =>
  sdk.semaphore.withPermits(1)(closeSession(sdk))

const makeClient = (
  url: string,
  authToken: Redacted.Redacted<string> | undefined,
  concurrentTransactionsEnabled: boolean,
  options?: TursoCloudClientOptions,
): Effect.Effect<
  TursoCloudClientServices,
  never,
  Scope.Scope | Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite()
    const spanAttributes: Array<[string, unknown]> = [
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ]
    const refreshAuthToken = options?.refreshAuthToken
    const createSdk = (nextAuthToken: Redacted.Redacted<string> | undefined) =>
      Effect.map(
        Effect.makeSemaphore(1),
        (semaphore): TursoSdk =>
          nextAuthToken
            ? {
                session: new TursoSession({
                  url,
                  authToken: Redacted.value(nextAuthToken),
                }),
                semaphore,
              }
            : { session: new TursoSession({ url }), semaphore },
      )
    const areAuthTokensEqual = (
      left: Redacted.Redacted<string> | undefined,
      right: Redacted.Redacted<string> | undefined,
    ) => {
      if (left === undefined || right === undefined) {
        return left === right
      }

      return Redacted.value(left) === Redacted.value(right)
    }
    let currentAuthToken = authToken
    const sdkRef = yield* Effect.acquireRelease(
      Effect.map(createSdk(currentAuthToken), (current) => ({ current })),
      (sdkRef) => closeSdk(sdkRef.current),
    )

    class TursoCloudConnectionImpl implements TursoCloudConnection {
      private pragmasExecuted = false
      private sdkClosed = false

      constructor(
        private readonly sdk: TursoSdk | undefined,
        private readonly runPragmas: boolean,
        private readonly closeSdkAfterTransaction: boolean,
      ) {}

      private withStatementSdk<A>(
        operation: (session: TursoSession) => Promise<A>,
        errorMessage = "Failed to execute statement",
      ): Effect.Effect<A, SqlError> {
        return this.withStatementSdkEffect((session) =>
          Effect.tryPromise({
            try: () => operation(session),
            catch: (cause) => makeSqlError(errorMessage, cause),
          }),
        )
      }

      private withStatementSdkEffect<A, E, R>(
        operation: (session: TursoSession) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> {
        return Effect.suspend(() => {
          const sdk = this.sdk ?? sdkRef.current
          return sdk.semaphore.withPermits(1)(operation(sdk.session))
        })
      }

      private closeTransactionSdk(): Effect.Effect<void, never> {
        if (!this.sdk || !this.closeSdkAfterTransaction || this.sdkClosed) {
          return Effect.void
        }

        this.sdkClosed = true
        return closeSdk(this.sdk)
      }

      private refreshSdkOnTokenChange(): Effect.Effect<boolean, never> {
        if (this.sdk || !this.runPragmas || !refreshAuthToken) {
          return Effect.succeed(false)
        }

        return Effect.gen(this, function* () {
          const nextAuthToken = yield* refreshAuthToken
          if (areAuthTokensEqual(currentAuthToken, nextAuthToken)) {
            return false
          }

          const previousSdk = sdkRef.current
          sdkRef.current = yield* createSdk(nextAuthToken)
          currentAuthToken = nextAuthToken
          this.pragmasExecuted = false
          yield* closeSdk(previousSdk)

          return true
        })
      }

      private recreateSdk(): Effect.Effect<void, never> {
        if (this.sdk || !this.runPragmas) {
          return Effect.void
        }

        return Effect.gen(this, function* () {
          const previousSdk = sdkRef.current
          sdkRef.current = yield* createSdk(currentAuthToken)
          this.pragmasExecuted = false
          yield* closeSdk(previousSdk)
        })
      }

      private runWithTokenRefresh<A>(
        effect: Effect.Effect<A, SqlError>,
      ): Effect.Effect<A, SqlError> {
        const retried = this.retryTursoLock(effect)
        return retried.pipe(
          Effect.catchAll((error) =>
            Effect.gen(this, function* () {
              const refreshed = yield* this.refreshSdkOnTokenChange()
              if (refreshed) {
                return yield* retried
              }

              if (isHttpNotFound(error.cause)) {
                yield* this.recreateSdk()
                return yield* retried
              }

              return yield* Effect.fail(error)
            }),
          ),
        )
      }

      private retryTursoLock<A>(
        effect: Effect.Effect<A, SqlError>,
        retryWhile: (error: SqlError) => boolean = isSqlLockError,
      ): Effect.Effect<A, SqlError> {
        return effect.pipe(
          Effect.retry({
            schedule: TURSO_LOCK_RETRY_SCHEDULE,
            while: retryWhile,
          }),
        )
      }

      private ensurePragmas(): Effect.Effect<void, SqlError> {
        if (this.pragmasExecuted || !this.runPragmas) {
          return Effect.void
        }

        return Effect.gen(this, function* () {
          yield* this.runDirect("PRAGMA foreign_keys = ON", [])
          this.pragmasExecuted = true
        })
      }

      private runDirect(sql: string, params: ReadonlyArray<unknown>) {
        return Effect.gen(this, function* () {
          const result = yield* this.withStatementSdk((session) =>
            session.execute(sql, Array.from(params)),
          )

          return resultRows(normalizeResultSet(result))
        })
      }

      readonly run = Effect.fn("TursoCloudConnection.run")(function* (
        this: TursoCloudConnectionImpl,
        sql: string,
        params: ReadonlyArray<unknown> = [],
      ) {
        return yield* this.runWithTokenRefresh(
          Effect.gen(this, function* () {
            yield* this.ensurePragmas()
            return yield* this.runDirect(sql, params)
          }),
        )
      })

      readonly runRaw = Effect.fn("TursoCloudConnection.runRaw")(function* (
        this: TursoCloudConnectionImpl,
        sql: string,
        params: ReadonlyArray<unknown> = [],
      ) {
        return yield* this.runWithTokenRefresh(
          Effect.gen(this, function* () {
            yield* this.ensurePragmas()
            return yield* this.withStatementSdk((session) =>
              session.execute(sql, Array.from(params)).then(normalizeResultSet),
            )
          }),
        )
      })

      readonly runBatch = Effect.fn("TursoCloudConnection.runBatch")(function* (
        this: TursoCloudConnectionImpl,
        input: {
          readonly statements: ReadonlyArray<string>
          readonly foreignKeys: "enforced" | "disabled-during-batch"
        },
      ) {
        if (input.foreignKeys === "enforced") {
          yield* this.ensurePragmas()
          yield* this.retryTursoLock(
            this.withStatementSdk(
              (session) =>
                session.batch(Array.from(input.statements), "immediate"),
              "Failed to execute batch",
            ),
            isRetryableSqlLockError,
          )
          return
        }

        yield* this.withStatementSdkEffect((session) =>
          Effect.gen(this, function* () {
            this.pragmasExecuted = false
            const batchAttempt = yield* this.retryTursoLock(
              Effect.tryPromise({
                try: async () => {
                  await session.execute("PRAGMA foreign_keys = OFF", [])
                  await session.batch(Array.from(input.statements), "immediate")
                },
                catch: (cause) =>
                  makeSqlError("Failed to execute batch", cause),
              }),
              isRetryableSqlLockError,
            ).pipe(
              Effect.match({
                onFailure: (cause): SqlAttempt => ({ kind: "failed", cause }),
                onSuccess: (): SqlAttempt => ({ kind: "succeeded" }),
              }),
            )

            const restoreAttempt = yield* this.retryTursoLock(
              Effect.tryPromise({
                try: () =>
                  session
                    .execute("PRAGMA foreign_keys = ON", [])
                    .then(() => undefined),
                catch: (cause) =>
                  makeSqlError("Failed to restore foreign keys", cause),
              }),
              isRetryableSqlLockError,
            ).pipe(
              Effect.match({
                onFailure: (cause): SqlAttempt => ({ kind: "failed", cause }),
                onSuccess: (): SqlAttempt => ({ kind: "succeeded" }),
              }),
            )

            if (restoreAttempt.kind === "succeeded") {
              this.pragmasExecuted = true
            } else if (batchAttempt.kind === "failed") {
              return yield* Effect.fail(
                new SqlError({
                  message: "Failed to execute batch",
                  cause: new Error(
                    `Failed to restore foreign keys after batch failure: ${describeCause(restoreAttempt.cause)}`,
                    { cause: batchAttempt.cause },
                  ),
                }),
              )
            } else {
              return yield* Effect.fail(restoreAttempt.cause)
            }

            if (batchAttempt.kind === "failed") {
              return yield* Effect.fail(batchAttempt.cause)
            }
          }),
        )
      })

      execute(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return transformRows
          ? Effect.map(this.run(sql, params), transformRows)
          : this.run(sql, params)
      }

      executeRaw(sql: string, params: ReadonlyArray<unknown>) {
        return this.runRaw(sql, params)
      }

      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return Effect.map(this.runRaw(sql, params), (result) =>
          resultValues(result).map((row) => Array.from(row)),
        )
      }

      executeUnprepared(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return this.execute(sql, params, transformRows)
      }

      executeStream() {
        return Stream.fail(
          new SqlError({
            message: "executeStream not implemented for Turso",
          }),
        )
      }

      private readonly beginTransactionBody = Effect.fn(
        "TursoCloudConnection.beginTransaction",
      )(function* (this: TursoCloudConnectionImpl) {
        // Wrap token-refresh retries inside the named span so attribution
        // matches run/runRaw (refresh work belongs to this operation).
        return yield* this.runWithTokenRefresh(
          Effect.gen(this, function* () {
            yield* this.ensurePragmas()
            const transactionSdk = yield* createSdk(currentAuthToken)
            const concurrentTransaction = yield* FiberRef.get(
              concurrentTransactionRequested,
            )
            yield* FiberRef.set(
              transactionMode,
              concurrentTransaction && concurrentTransactionsEnabled
                ? "concurrent"
                : "immediate",
            )
            yield* Effect.tryPromise({
              try: async () => {
                await transactionSdk.session.execute(
                  "PRAGMA foreign_keys = ON",
                  [],
                )
                await transactionSdk.session.sequence(
                  concurrentTransaction
                    ? concurrentTransactionsEnabled
                      ? "BEGIN CONCURRENT"
                      : "BEGIN IMMEDIATE"
                    : options?.deferredTransactions
                      ? "BEGIN DEFERRED"
                      : "BEGIN IMMEDIATE",
                )
              },
              catch: (cause) =>
                makeSqlError("Failed to begin transaction", cause),
            }).pipe(Effect.tapError(() => closeSdk(transactionSdk)))

            return new TursoCloudConnectionImpl(transactionSdk, false, true)
          }),
        )
      })

      get beginTransaction(): Effect.Effect<TursoCloudConnection, SqlError> {
        return this.beginTransactionBody()
      }

      private readonly commitBody = Effect.fn("TursoCloudConnection.commit")(
        function (this: TursoCloudConnectionImpl) {
          return Effect.uninterruptible(
            Effect.tryPromise({
              try: () => {
                if (!this.sdk) {
                  return Promise.reject(
                    new Error("Transaction connection missing"),
                  )
                }

                return this.sdk.session.sequence("COMMIT")
              },
              catch: (cause) =>
                makeSqlError("Failed to commit transaction", cause),
            }).pipe(
              Effect.retry({
                schedule: TURSO_LOCK_RETRY_SCHEDULE,
                while: isRetryableSqlLockError,
              }),
              Effect.tap(() => this.closeTransactionSdk()),
            ),
          )
        },
      )

      get commit() {
        return this.commitBody()
      }

      private readonly rollbackBody = Effect.fn(
        "TursoCloudConnection.rollback",
      )(function (this: TursoCloudConnectionImpl) {
        return this.retryTursoLock(
          Effect.tryPromise({
            try: () => {
              if (!this.sdk) {
                return Promise.reject(
                  new Error("Transaction connection missing"),
                )
              }

              return this.sdk.session.sequence("ROLLBACK")
            },
            catch: (cause) =>
              makeSqlError("Failed to rollback transaction", cause),
          }),
        ).pipe(Effect.ensuring(this.closeTransactionSdk()))
      })

      get rollback() {
        return this.rollbackBody()
      }
    }

    const connection = new TursoCloudConnectionImpl(undefined, true, false)
    const withTransaction = Client.makeWithTransaction({
      transactionTag: TursoCloudTransaction,
      spanAttributes,
      acquireConnection: Effect.uninterruptibleMask((restore) =>
        Scope.make().pipe(
          Effect.flatMap((scope) =>
            // Do not serialize transaction starts in-process; cross-runtime
            // lock contention is handled by the bounded BEGIN retry above.
            restore(connection.beginTransaction).pipe(
              Effect.map((conn) => [scope, conn] as const),
              Effect.tapError(() => Scope.close(scope, Exit.void)),
            ),
          ),
        ),
      ),
      begin: () => Effect.void,
      savepoint: (conn, id) =>
        conn.executeRaw(`SAVEPOINT effect_sql_${id};`, []),
      commit: (conn) =>
        conn.commit.pipe(
          Effect.catchAll((error) =>
            conn.rollback.pipe(
              Effect.catchAll((rollbackError) =>
                Effect.logWarning(
                  "Failed to rollback transaction after commit failure",
                ).pipe(Effect.annotateLogs({ rollbackError })),
              ),
              Effect.zipRight(
                FiberRef.get(concurrentTransactionRequested).pipe(
                  Effect.flatMap((concurrent) =>
                    concurrent
                      ? FiberRef.set(concurrentTransactionCommitError, error)
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
          ),
        ),
      rollback: (conn) => conn.rollback,
      rollbackSavepoint: (conn, id) =>
        conn.executeRaw(`ROLLBACK TO SAVEPOINT effect_sql_${id};`, []),
    })

    const acquirer = Effect.flatMap(
      Effect.serviceOption(TursoCloudTransaction),
      Option.match({
        onNone: () => Effect.succeed(connection as TursoCloudConnection),
        onSome: ([conn]) => Effect.succeed(conn),
      }),
    )

    const client = Object.assign(
      yield* Client.make({
        acquirer,
        compiler,
        spanAttributes,
      }),
      { withTransaction },
    )

    return {
      batch: {
        execute: (input) => connection.runBatch(input),
      } satisfies TursoCloudBatch["Type"],
      client,
    }
  })

const makeBaseTursoCloudLive = (options?: TursoCloudClientOptions) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const dbPath = yield* DatabasePathConfig
      const normalizedPath = normalizeDatabasePath(dbPath)
      const authToken = options?.authToken ?? (yield* AuthTokenConfig)
      const concurrentTransactionsEnabled = yield* ConcurrentTransactionsConfig
      const { batch, client } = yield* makeClient(
        normalizedPath,
        authToken,
        concurrentTransactionsEnabled,
        options,
      )

      return Context.make(Client.SqlClient, client).pipe(
        Context.add(TursoCloudBatch, batch),
      )
    }),
  ).pipe(Layer.provide(Reactivity.layer))

export const makeTursoCloudLive = (
  options?: TursoCloudClientOptions,
): Layer.Layer<
  Client.SqlClient | TursoCloudBatch | DatabaseConnectionInfo,
  ConfigError,
  never
> =>
  makeBaseTursoCloudLive(options).pipe(Layer.provideMerge(ConnectionInfoLayer))

export const TursoCloudLive: Layer.Layer<
  Client.SqlClient | TursoCloudBatch | DatabaseConnectionInfo,
  ConfigError,
  never
> = makeTursoCloudLive()
