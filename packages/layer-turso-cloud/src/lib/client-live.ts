import { Session as TursoSession } from "@tursodatabase/serverless"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type { ConfigError } from "effect/Config"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Client from "effect/sql/SqlClient"
import type { Connection as SqlConnection } from "effect/sql/SqlConnection"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import {
  DatabaseConnectionInfo,
  DatabasePathConfig,
  SqlReadBatch,
  SqlReadBatchError,
  type SqlReadRows,
  type SqlReadStatement,
  causeChainIncludes,
  concurrentTransactionCommitError,
  concurrentTransactionRequested,
  deferredTransactionRequested,
  getTursoHttpStatus,
  immediateTransactionRequested,
  isSqlLockError,
  isSqlWriteWriteConflictError,
  normalizeDatabasePath,
  readSnapshotRequested,
  transactionMode,
} from "@pf/db-info"

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const TURSO_LOCK_MAX_RETRIES = 5
const TURSO_LOCK_RETRY_SCHEDULE = Schedule.max([
  Schedule.exponential("100 millis", 2),
  Schedule.recurs(TURSO_LOCK_MAX_RETRIES),
]).pipe(Schedule.jittered)
const isRetryableSqlLockError = (error: unknown): boolean =>
  isSqlLockError(error) && !isSqlWriteWriteConflictError(error)

const AuthTokenConfig = Config.Redacted("TURSO_AUTH_TOKEN").pipe(
  Config.orElse(() => Config.succeed(undefined)),
)
const ConcurrentTransactionsConfig = Config.String("TURSO_CONCURRENT_TX").pipe(
  Config.map((value) => value === "1"),
  Config.orElse(() => Config.succeed(false)),
)

const ConnectionInfoLayer = Layer.effect(
  DatabaseConnectionInfo,
  DatabasePathConfig.pipe(Config.map(normalizeDatabasePath)),
)

const TursoCloudTransaction = Context.Service<
  readonly [TursoCloudConnection, counter: number]
>("@pf/layer-turso-cloud/TursoCloudTransaction")

export class TursoCloudBatch extends Context.Service<
  TursoCloudBatch,
  {
    /** Executes all statements atomically, with an explicit foreign-key policy. */
    readonly execute: (input: {
      readonly statements: ReadonlyArray<string>
      readonly foreignKeys: "enforced" | "disabled-during-batch"
    }) => Effect.Effect<void, SqlError>
  }
>()("@pf/layer-turso-cloud/TursoCloudBatch") {}

interface TursoCloudClientServices {
  readonly batch: TursoCloudBatch["Service"]
  readonly readBatch: SqlReadBatch["Service"]
  readonly client: Client.SqlClient
}

type SqlAttempt =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly cause: SqlError }

interface TursoCloudConnection extends SqlConnection {
  readonly executeReadBatch: SqlReadBatch["Service"]["execute"]
  readonly beginTransaction: Effect.Effect<TursoCloudConnection, SqlError>
  readonly commit: Effect.Effect<void, SqlError>
  readonly rollback: Effect.Effect<void, SqlError>
  /** Returns the leased transaction session, discarding it when it is unusable. */
  readonly release: Effect.Effect<void, never>
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
  /** Deployment dimensions for metric backends that do not promote resources. */
  readonly metricDimensions?: {
    readonly environment: string
  }
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

const requests = Metric.counter("pf.turso.requests", {
  description: "Completed Turso client requests",
  incremental: true,
})

type RequestOperation =
  | "execute"
  | "read_batch"
  | "batch"
  | "begin"
  | "commit"
  | "rollback"

const requestErrorAttributes = (cause: unknown): Metric.Metric.Attributes => {
  const status = getTursoHttpStatus(cause)
  if (status !== undefined) return { "http.status_code": String(status) }
  const errorType = isTursoReadsBlocked(cause)
    ? "reads_blocked"
    : causeChainIncludes(cause, (message) => /econnreset/iu.test(message), {
          codePredicate: (code) => code === "ECONNRESET",
        })
      ? "econnreset"
      : causeChainIncludes(
            cause,
            (message) => /socket.*closed/iu.test(message),
            {
              codePredicate: (code) => code === "UND_ERR_SOCKET",
            },
          )
        ? "socket_closed"
        : "other"
  return { "error.type": errorType }
}

const makeSqlError = (message: string, cause: unknown) =>
  new SqlError({
    reason: new UnknownError({
      cause: new Error(`${message}: ${describeCause(cause)}`, { cause }),
      message: isTursoReadsBlocked(cause)
        ? `${message} (${TURSO_READS_BLOCKED_HINT})`
        : message,
    }),
  })

const isHttpNotFound = (cause: unknown): boolean =>
  causeChainIncludes(cause, (message) =>
    message.includes("HTTP error! status: 404"),
  )

// Validate the SDK's untyped partial-result error once at the driver boundary.
const partialReadBatch = Schema.Struct({
  batchIndex: Schema.Number,
  batchResults: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        rows: Schema.Array(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
})

// Session preserves complete result sets; the semaphore protects its single Hrana baton.
interface TursoSdk {
  readonly session: TursoSession
  readonly semaphore: Semaphore.Semaphore
  pragmasExecuted: boolean
}

/** A dedicated transaction session kept alive between transactions. */
interface TursoTransactionSdk {
  readonly sdk: TursoSdk
  readonly authToken: Redacted.Redacted<string> | undefined
}

/**
 * Exclusive use of the process transaction session.
 *
 * The transaction baton is held for the whole transaction, so the pooled
 * session is only handed out while it is idle and overlapping transactions
 * queue instead of sharing one session.
 */
interface TursoTransactionLease {
  readonly sdk: TursoSdk
  /** Serializes statements on the leased connection; the baton is already held. */
  readonly statements: Semaphore.Semaphore
  /** Set once on a successful COMMIT; flags below only move forward. */
  committed: boolean
  /** Set once when the lease is returned; guards the baton release. */
  released: boolean
}

const closeSession = (sdk: TursoSdk): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => sdk.session.close(),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((e) =>
      Effect.logWarning("Failed to close Turso connection", Cause.fail(e)),
    ),
  )

const closeSdk = (sdk: TursoSdk): Effect.Effect<void, never> =>
  sdk.semaphore.withPermits(1)(closeSession(sdk))

const closeSdkOnScopeClose = (sdk: TursoSdk): Effect.Effect<void, never> =>
  sdk.semaphore
    .withPermitsIfAvailable(1)(closeSession(sdk))
    .pipe(
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.void,
          // A cancelled read may still own the SDK's non-abortable request. Queue
          // its close behind that baton without making scope cleanup wait for HTTP.
          onNone: () =>
            closeSdk(sdk).pipe(
              Effect.forkDetach({ uninterruptible: true }),
              Effect.asVoid,
            ),
        }),
      ),
    )

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
    const dimensions = options?.metricDimensions
    const requestCounter = dimensions
      ? Metric.withAttributes(requests, {
          "pf.env": dimensions.environment,
        })
      : requests

    const trackRequest = async <A>(
      context: Context.Context<never>,
      operation: RequestOperation,
      run: () => PromiseLike<A>,
    ): Promise<A> => {
      // Count attempts before retries, even if a non-abortable SDK call
      // finishes after its caller was interrupted.
      let value: A
      try {
        value = await run()
      } catch (cause) {
        requestCounter
          .pipe(
            Metric.withAttributes(requestErrorAttributes(cause)),
            Metric.withAttributes({ operation, outcome: "error" }),
          )
          .updateUnsafe(1, context)
        throw cause
      }
      Metric.withAttributes(requestCounter, {
        operation,
        outcome: "ok",
      }).updateUnsafe(1, context)
      return value
    }

    const tursoRequest = <A, E>(
      operation: RequestOperation,
      {
        try: run,
        catch: mapError,
      }: {
        readonly try: () => PromiseLike<A>
        readonly catch: (cause: unknown) => E
      },
    ): Effect.Effect<A, E> =>
      Effect.contextWith((context) =>
        Effect.tryPromise({
          try: () => trackRequest(context, operation, run),
          catch: mapError,
        }),
      )
    const createSdk = (nextAuthToken: Redacted.Redacted<string> | undefined) =>
      Effect.map(
        Semaphore.make(1),
        (semaphore): TursoSdk =>
          nextAuthToken
            ? {
                session: new TursoSession({
                  url,
                  authToken: Redacted.value(nextAuthToken),
                }),
                semaphore,
                pragmasExecuted: false,
              }
            : {
                session: new TursoSession({ url }),
                semaphore,
                pragmasExecuted: false,
              },
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
      (sdkRef) => closeSdkOnScopeClose(sdkRef.current),
    )

    // Writes reuse one dedicated session instead of creating and closing a
    // session per transaction. The baton is held for the whole transaction, so
    // overlapping transactions queue here and a hand-out is always idle.
    const transactionBaton = yield* Semaphore.make(1)
    const transactionSdkRef = yield* Effect.acquireRelease(
      Ref.make<Option.Option<TursoTransactionSdk>>(Option.none()),
      (ref) =>
        Effect.flatMap(Ref.get(ref), (current) =>
          Option.match(current, {
            onNone: () => Effect.void,
            onSome: (transactionSdk) => closeSdk(transactionSdk.sdk),
          }),
        ),
    )

    const makeTransactionLease = (sdk: TursoSdk): TursoTransactionLease => ({
      sdk,
      statements: Semaphore.makeUnsafe(1),
      committed: false,
      released: false,
    })

    // Only the wait for the baton is interruptible. Once the baton is taken the
    // lease is returned with it, so preparation cannot strand the permit.
    const prepareTransactionLease: Effect.Effect<TursoTransactionLease> =
      Effect.gen(function* () {
        const existing = yield* Ref.get(transactionSdkRef)
        const reusable = Option.flatMap(existing, (transactionSdk) =>
          areAuthTokensEqual(transactionSdk.authToken, currentAuthToken)
            ? Option.some(transactionSdk.sdk)
            : Option.none(),
        )
        if (Option.isSome(reusable)) {
          return makeTransactionLease(reusable.value)
        }

        if (Option.isSome(existing)) {
          // The auth token rotated, so the previous session must not be reused.
          yield* Ref.set(transactionSdkRef, Option.none())
          yield* closeSession(existing.value.sdk)
        }

        const sdk = yield* createSdk(currentAuthToken)
        yield* Ref.set(
          transactionSdkRef,
          Option.some({ sdk, authToken: currentAuthToken }),
        )
        return makeTransactionLease(sdk)
      })

    const acquireTransactionLease: Effect.Effect<TursoTransactionLease> =
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(Semaphore.take(transactionBaton, 1))
          return yield* prepareTransactionLease.pipe(
            // A failure here never reaches a caller that could release the
            // baton, so the baton is given back before the failure surfaces.
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Semaphore.release(transactionBaton, 1)
                : Effect.void,
            ),
          )
        }),
      )

    const releaseTransactionLease = (
      lease: TursoTransactionLease,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (lease.released) {
          return Effect.void
        }

        lease.released = true
        // A failed or interrupted transaction may have left the session in an
        // uncertain state, so only a committed transaction returns it to reuse.
        const discard = !lease.committed
        return Effect.uninterruptible(
          Effect.gen(function* () {
            if (discard) {
              yield* Ref.update(transactionSdkRef, (current) =>
                Option.isSome(current) && current.value.sdk === lease.sdk
                  ? Option.none()
                  : current,
              )
            }

            yield* Semaphore.release(transactionBaton, 1)

            if (discard) {
              yield* closeSession(lease.sdk)
            }
          }),
        )
      })

    class TursoCloudConnectionImpl implements TursoCloudConnection {
      constructor(
        private readonly lease: TursoTransactionLease | undefined,
        private readonly runPragmas: boolean,
      ) {}

      private withStatementSdkEffect<A, E, R>(
        operation: (
          session: TursoSession,
          sdk: TursoSdk,
        ) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> {
        return Effect.suspend(() => {
          const lease = this.lease
          const sdk = lease?.sdk ?? sdkRef.current
          return (lease?.statements ?? sdk.semaphore).withPermits(1)(
            Effect.suspend(() => operation(sdk.session, sdk)),
          )
        })
      }

      private withReadBatchSdk<A>(
        operation: (
          session: TursoSession,
          sdk: TursoSdk,
        ) => Effect.Effect<A, SqlError>,
      ): Effect.Effect<A, SqlError> {
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen({ self: this }, function* () {
            const sdk = this.lease?.sdk ?? sdkRef.current
            const semaphore = this.lease?.statements ?? sdk.semaphore
            yield* restore(Semaphore.take(semaphore, 1))
            // The SDK cannot accept an AbortSignal. Cancel the caller promptly,
            // but keep the baton leased until the in-flight request settles.
            const request = yield* Effect.suspend(() =>
              operation(sdk.session, sdk),
            ).pipe(
              Effect.ensuring(Semaphore.release(semaphore, 1)),
              Effect.forkDetach({ uninterruptible: true }),
            )
            return yield* restore(Fiber.join(request))
          }),
        )
      }

      get release(): Effect.Effect<void, never> {
        return this.lease ? releaseTransactionLease(this.lease) : Effect.void
      }

      private refreshSdkOnTokenChange(): Effect.Effect<boolean, never> {
        if (this.lease !== undefined || !this.runPragmas || !refreshAuthToken) {
          return Effect.succeed(false)
        }

        return Effect.gen({ self: this }, function* () {
          const nextAuthToken = yield* refreshAuthToken
          if (areAuthTokensEqual(currentAuthToken, nextAuthToken)) {
            return false
          }

          const previousSdk = sdkRef.current
          sdkRef.current = yield* createSdk(nextAuthToken)
          currentAuthToken = nextAuthToken
          yield* closeSdk(previousSdk)

          return true
        })
      }

      private recreateSdk(): Effect.Effect<void, never> {
        if (this.lease !== undefined || !this.runPragmas) {
          return Effect.void
        }

        return Effect.gen({ self: this }, function* () {
          const previousSdk = sdkRef.current
          sdkRef.current = yield* createSdk(currentAuthToken)
          yield* closeSdk(previousSdk)
        })
      }

      private runWithTokenRefresh<A>(
        effect: Effect.Effect<A, SqlError>,
        options?: {
          /**
           * Whether a 404 also rebuilds the root read session. Transaction
           * acquisition excludes it: the failed transaction session is already
           * discarded and the retry builds a fresh one, so the shared read
           * session never caused the 404 and must not be churned for it.
           */
          readonly recreateRootOnNotFound?: boolean
        },
      ): Effect.Effect<A, SqlError> {
        const retried = this.retryTursoLock(effect)
        return retried.pipe(
          Effect.catch((error) =>
            Effect.gen({ self: this }, function* () {
              const refreshed = yield* this.refreshSdkOnTokenChange()
              if (refreshed) {
                return yield* retried
              }

              if (isHttpNotFound(error.cause)) {
                if (options?.recreateRootOnNotFound ?? true) {
                  yield* this.recreateSdk()
                }
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
        return Effect.gen(function* () {
          const span = yield* Effect.option(Effect.currentSpan)
          let attempts = 0
          return yield* Effect.suspend(() => {
            attempts += 1
            return effect
          }).pipe(
            Effect.retry({
              schedule: TURSO_LOCK_RETRY_SCHEDULE.pipe(
                // Tap only decisions that actually permit a retry.
                Schedule.while(
                  ({ input }: Schedule.Metadata<unknown, SqlError>) =>
                    Effect.succeed(retryWhile(input)),
                ),
                Schedule.tap(({ attempt, input, duration }) =>
                  Effect.gen(function* () {
                    if (Option.isSome(span)) {
                      const now = yield* Clock.currentTimeNanos
                      span.value.event("turso.lock_retry", now, {
                        "turso.retry.attempt": attempt,
                        "turso.retry.failure_kind": isSqlLockError(input)
                          ? "lock/busy"
                          : "other",
                        "turso.retry.delay_ms": Duration.toMillis(duration),
                      })
                    }
                  }),
                ),
              ),
            }),
            Effect.tapError((error) =>
              attempts === TURSO_LOCK_MAX_RETRIES + 1 && retryWhile(error)
                ? Effect.logWarning("Turso lock retries exhausted").pipe(
                    Effect.annotateLogs({
                      "turso.retry.attempt_count": attempts,
                      "turso.retry.failure_kind": isSqlLockError(error)
                        ? "lock/busy"
                        : "other",
                    }),
                  )
                : Effect.void,
            ),
            Effect.onExit(() =>
              Effect.sync(() => {
                if (attempts > 1 && Option.isSome(span)) {
                  span.value.attribute("turso.retry.attempt_count", attempts)
                }
              }),
            ),
          )
        })
      }

      // Effect SQL does not install the transaction span while acquiring its
      // connection, and statement propagation is opt-in. Record on the active
      // caller span (or SQL span when propagated), never a misleading sibling.
      private initialization<A>(
        operation: "statement" | "begin" | "pragma",
        effect: Effect.Effect<A, SqlError>,
      ): Effect.Effect<A, SqlError> {
        return Effect.gen(function* () {
          const span = yield* Effect.option(Effect.currentSpan)
          const start = yield* Clock.currentTimeNanos
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const end = yield* Clock.currentTimeNanos
                if (Option.isSome(span)) {
                  span.value.event("turso.session.first_use", end, {
                    "turso.initialization.operation": operation,
                    "turso.initialization.duration_ms":
                      Number(end - start) / 1e6,
                    "turso.initialization.success": Exit.isSuccess(exit),
                  })
                }
              }),
            ),
          )
        })
      }

      // Called only while holding this session's baton permit.
      private ensurePragmas(sdk: TursoSdk): Effect.Effect<void, SqlError> {
        if (sdk.pragmasExecuted || !this.runPragmas) return Effect.void
        return this.initialization(
          "pragma",
          tursoRequest("execute", {
            try: async () => {
              await sdk.session.execute("PRAGMA foreign_keys = ON", [])
              sdk.pragmasExecuted = true
            },
            catch: (cause) =>
              makeSqlError("Failed to execute statement", cause),
          }),
        )
      }

      run(sql: string, params: ReadonlyArray<unknown> = []) {
        return Effect.map(this.runRaw(sql, params), resultRows)
      }

      runRaw(sql: string, params: ReadonlyArray<unknown> = []) {
        return this.runWithTokenRefresh(
          this.withStatementSdkEffect((session, sdk) => {
            if (sdk.pragmasExecuted || !this.runPragmas) {
              return tursoRequest("execute", {
                try: () =>
                  session
                    .execute(sql, Array.from(params))
                    .then(normalizeResultSet),
                catch: (cause) =>
                  makeSqlError("Failed to execute statement", cause),
              })
            }
            return this.initialization(
              "statement",
              tursoRequest("execute", {
                try: async () => {
                  // No implicit transaction: FK enforcement must precede BEGIN.
                  // The SDK gates each step on the previous step's success.
                  const results: ServerlessResultSet[] = await session.batch(
                    [
                      "PRAGMA foreign_keys = ON",
                      { sql, args: Array.from(params) },
                    ],
                    undefined,
                    undefined,
                    false,
                    true,
                  )
                  sdk.pragmasExecuted = true
                  const result = results[1]
                  if (!result)
                    throw new Error("Missing initialized statement result")
                  return normalizeResultSet(result)
                },
                catch: (cause) => {
                  // A failed application statement can follow a successful PRAGMA.
                  // There is only one application step, so no completed write is
                  // replayed when the existing lock retry handles that failure.
                  if (
                    cause instanceof Error &&
                    "batchResults" in cause &&
                    Array.isArray(cause.batchResults) &&
                    cause.batchResults[0]
                  ) {
                    sdk.pragmasExecuted = true
                  }
                  return makeSqlError("Failed to execute statement", cause)
                },
              }),
            )
          }),
        )
      }

      executeReadBatch(
        statements: ReadonlyArray<SqlReadStatement>,
      ): Effect.Effect<ReadonlyArray<SqlReadRows>, SqlError> {
        if (statements.length === 0) return Effect.succeed([])
        // Deliberately outside retryTursoLock: a partial response must not replay
        // already completed statements. Only rejected HTTP requests may retry.
        const execute = this.withReadBatchSdk((session, sdk) => {
          const initialize = this.runPragmas && !sdk.pragmasExecuted
          const offset = initialize ? 1 : 0
          const input = statements.map(({ sql, params }) => ({
            sql,
            args: Array.from(params),
          }))
          const execute = tursoRequest("read_batch", {
            try: async () => {
              const results: ServerlessResultSet[] = await session.batch(
                initialize ? ["PRAGMA foreign_keys = ON", ...input] : input,
                undefined,
                undefined,
                false,
                true,
              )
              if (initialize) sdk.pragmasExecuted = true
              return results
                .slice(offset)
                .map((result) => result.rows.map((row) => Array.from(row)))
            },
            catch: (cause) => {
              const partial =
                Schema.decodeUnknownOption(partialReadBatch)(cause)
              if (Option.isSome(partial)) {
                const { batchIndex, batchResults } = partial.value
                if (initialize && batchResults[0]) sdk.pragmasExecuted = true
                if (
                  batchIndex >= offset &&
                  batchIndex < input.length + offset &&
                  batchResults.length === input.length + offset
                ) {
                  const statementIndex = batchIndex - offset
                  const failure = new SqlReadBatchError({
                    statementIndex,
                    results: batchResults
                      .slice(offset)
                      .map((result) => result?.rows ?? null),
                    message: `Read batch statement ${statementIndex} failed: ${describeCause(cause)}`,
                    cause,
                  })
                  return new SqlError({
                    reason: new UnknownError({
                      message: failure.message,
                      cause: failure,
                    }),
                  })
                }
              }
              return makeSqlError("Failed to execute read batch", cause)
            },
          })
          return initialize
            ? this.initialization("statement", execute)
            : execute
        })
        return execute.pipe(
          Effect.catch((error) =>
            Effect.gen({ self: this }, function* () {
              const notFound = isHttpNotFound(error.cause)
              const unauthorized = causeChainIncludes(error.cause, (message) =>
                message.includes("HTTP error! status: 401"),
              )
              if (
                error.reason.cause instanceof SqlReadBatchError ||
                (!notFound && !unauthorized)
              ) {
                return yield* Effect.fail(error)
              }
              const refreshed = yield* this.refreshSdkOnTokenChange()
              if (!refreshed && !notFound) return yield* Effect.fail(error)
              if (!refreshed) yield* this.recreateSdk()
              return yield* execute
            }),
          ),
        )
      }

      readonly runBatch = Effect.fn("TursoCloudConnection.runBatch")(function* (
        this: TursoCloudConnectionImpl,
        input: {
          readonly statements: ReadonlyArray<string>
          readonly foreignKeys: "enforced" | "disabled-during-batch"
        },
      ) {
        if (input.foreignKeys === "enforced") {
          yield* this.retryTursoLock(
            this.withStatementSdkEffect((session, sdk) =>
              Effect.gen({ self: this }, function* () {
                yield* this.ensurePragmas(sdk)
                yield* tursoRequest("batch", {
                  try: () =>
                    session.batch(Array.from(input.statements), "immediate"),
                  catch: (cause) =>
                    makeSqlError("Failed to execute batch", cause),
                })
              }),
            ),
            isRetryableSqlLockError,
          )
          return
        }

        yield* this.withStatementSdkEffect((session, sdk) =>
          Effect.gen({ self: this }, function* () {
            sdk.pragmasExecuted = false
            const batchAttempt = yield* this.retryTursoLock(
              Effect.contextWith((context) =>
                Effect.tryPromise({
                  try: async () => {
                    await trackRequest(context, "execute", () =>
                      session.execute("PRAGMA foreign_keys = OFF", []),
                    )
                    await trackRequest(context, "batch", () =>
                      session.batch(Array.from(input.statements), "immediate"),
                    )
                  },
                  catch: (cause) =>
                    makeSqlError("Failed to execute batch", cause),
                }),
              ),
              isRetryableSqlLockError,
            ).pipe(
              Effect.match({
                onFailure: (cause): SqlAttempt => ({ kind: "failed", cause }),
                onSuccess: (): SqlAttempt => ({ kind: "succeeded" }),
              }),
            )

            const restoreAttempt = yield* this.retryTursoLock(
              tursoRequest("execute", {
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
              sdk.pragmasExecuted = true
            } else if (batchAttempt.kind === "failed") {
              return yield* Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    message: "Failed to execute batch",
                    cause: new Error(
                      `Failed to restore foreign keys after batch failure: ${describeCause(restoreAttempt.cause)}`,
                      { cause: batchAttempt.cause },
                    ),
                  }),
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

      executeValuesUnprepared(sql: string, params: ReadonlyArray<unknown>) {
        return this.executeValues(sql, params)
      }

      executeStream() {
        return Stream.fail(
          new SqlError({
            reason: new UnknownError({
              cause: undefined,
              message: "executeStream not implemented for Turso",
            }),
          }),
        )
      }

      private beginOnLease(
        lease: TursoTransactionLease,
      ): Effect.Effect<TursoCloudConnection, SqlError> {
        return Effect.gen({ self: this }, function* () {
          const readSnapshot = yield* readSnapshotRequested
          const immediateTransaction = yield* immediateTransactionRequested
          const deferredTransaction = yield* deferredTransactionRequested
          const concurrentTransaction = yield* concurrentTransactionRequested
          const mode = yield* transactionMode
          if (mode)
            yield* Ref.set(
              mode,
              !readSnapshot &&
                !immediateTransaction &&
                !deferredTransaction &&
                concurrentTransaction &&
                concurrentTransactionsEnabled
                ? "concurrent"
                : "immediate",
            )
          yield* this.initialization(
            "begin",
            tursoRequest("begin", {
              try: async () => {
                // Keep foreign-key enforcement ahead of BEGIN; the lease
                // tracks that the session has applied it.
                await lease.sdk.session.batch([
                  "PRAGMA foreign_keys = ON",
                  readSnapshot
                    ? "BEGIN DEFERRED"
                    : immediateTransaction
                      ? "BEGIN IMMEDIATE"
                      : deferredTransaction
                        ? "BEGIN DEFERRED"
                        : concurrentTransaction
                          ? concurrentTransactionsEnabled
                            ? "BEGIN CONCURRENT"
                            : "BEGIN IMMEDIATE"
                          : options?.deferredTransactions
                            ? "BEGIN DEFERRED"
                            : "BEGIN IMMEDIATE",
                ])
                lease.sdk.pragmasExecuted = true
              },
              catch: (cause) =>
                makeSqlError("Failed to begin transaction", cause),
            }),
          )

          return new TursoCloudConnectionImpl(lease, false)
        })
      }

      private beginTransactionBody(): Effect.Effect<
        TursoCloudConnection,
        SqlError
      > {
        // Token refresh and lock retries are part of this BEGIN, not a later
        // query. sql.transaction already covers that work, so do not add a
        // sibling driver span.
        return this.runWithTokenRefresh(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen({ self: this }, function* () {
              const lease = yield* acquireTransactionLease
              // The release is installed in the same uninterruptible region
              // that takes the baton, so an interrupt cannot drop the lease
              // before it has an owner. The BEGIN request stays interruptible.
              return yield* restore(this.beginOnLease(lease)).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? releaseTransactionLease(lease)
                    : Effect.void,
                ),
              )
            }),
          ),
          // A 404 here came from the transaction session, not the read session.
          { recreateRootOnNotFound: false },
        )
      }

      get beginTransaction(): Effect.Effect<TursoCloudConnection, SqlError> {
        return this.beginTransactionBody()
      }

      private commitBody(): Effect.Effect<void, SqlError> {
        const lease = this.lease
        if (!lease) {
          return Effect.fail(
            makeSqlError(
              "Failed to commit transaction",
              new Error("Transaction connection missing"),
            ),
          )
        }

        return Effect.uninterruptible(
          this.retryTursoLock(
            tursoRequest("commit", {
              try: () => lease.sdk.session.sequence("COMMIT"),
              catch: (cause) =>
                makeSqlError("Failed to commit transaction", cause),
            }),
            isRetryableSqlLockError,
          ).pipe(
            lease.statements.withPermits(1),
            // A failed COMMIT keeps the lease so the rollback that follows can
            // still reach the server; it is then discarded, never reused.
            Effect.tap(() =>
              Effect.suspend(() => {
                lease.committed = true
                return releaseTransactionLease(lease)
              }),
            ),
          ),
        )
      }

      get commit() {
        return this.commitBody()
      }

      private rollbackBody(): Effect.Effect<void, SqlError> {
        const lease = this.lease
        if (!lease) {
          return Effect.fail(
            makeSqlError(
              "Failed to rollback transaction",
              new Error("Transaction connection missing"),
            ),
          )
        }

        return this.retryTursoLock(
          tursoRequest("rollback", {
            try: () => lease.sdk.session.sequence("ROLLBACK"),
            catch: (cause) =>
              makeSqlError("Failed to rollback transaction", cause),
          }),
        ).pipe(
          lease.statements.withPermits(1),
          Effect.ensuring(releaseTransactionLease(lease)),
        )
      }

      get rollback() {
        return this.rollbackBody()
      }
    }

    const connection = new TursoCloudConnectionImpl(undefined, true)
    const withTransaction = Client.makeWithTransaction({
      transactionService: TursoCloudTransaction,
      spanAttributes,
      // Transactions queue on the shared transaction session baton; the
      // bounded BEGIN retry still covers cross-runtime lock contention.
      acquireConnection: (restore) =>
        Effect.acquireRelease(
          restore(connection.beginTransaction),
          (conn) => conn.release,
        ),
      begin: () => Effect.void,
      savepoint: (conn, id) =>
        conn.executeRaw(`SAVEPOINT effect_sql_${id};`, []),
      commit: (conn) =>
        conn.commit.pipe(
          Effect.catch((error) =>
            conn.rollback.pipe(
              Effect.catch((rollbackError) =>
                Effect.logWarning(
                  "Failed to rollback transaction after commit failure",
                ).pipe(Effect.annotateLogs({ rollbackError })),
              ),
              Effect.andThen(
                concurrentTransactionRequested.pipe(
                  Effect.flatMap((concurrent) =>
                    concurrent
                      ? Effect.flatMap(
                          concurrentTransactionCommitError,
                          (ref) =>
                            ref ? Ref.set(ref, error) : Effect.fail(error),
                        )
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
        driver: "turso-cloud",
        acquirer,
        compiler,
        spanAttributes,
      }),
      { withTransaction },
    )

    return {
      batch: {
        execute: (input) => connection.runBatch(input),
      } satisfies TursoCloudBatch["Service"],
      readBatch: {
        execute: (statements) =>
          Effect.flatMap(acquirer, (conn) => conn.executeReadBatch(statements)),
      },
      client,
    }
  })

const makeBaseTursoCloudLive = (options?: TursoCloudClientOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const dbPath = yield* DatabasePathConfig
      const normalizedPath = normalizeDatabasePath(dbPath)
      const authToken = options?.authToken ?? (yield* AuthTokenConfig)
      const concurrentTransactionsEnabled = yield* ConcurrentTransactionsConfig
      const { batch, readBatch, client } = yield* makeClient(
        normalizedPath,
        authToken,
        concurrentTransactionsEnabled,
        options,
      )

      return Context.make(Client.SqlClient, client).pipe(
        Context.add(TursoCloudBatch, batch),
        Context.add(SqlReadBatch, readBatch),
      )
    }),
  ).pipe(Layer.provide(Reactivity.layer))

export const makeTursoCloudLive = (
  options?: TursoCloudClientOptions,
): Layer.Layer<
  Client.SqlClient | TursoCloudBatch | SqlReadBatch | DatabaseConnectionInfo,
  ConfigError,
  never
> =>
  makeBaseTursoCloudLive(options).pipe(Layer.provideMerge(ConnectionInfoLayer))

export const TursoCloudLive: Layer.Layer<
  Client.SqlClient | TursoCloudBatch | SqlReadBatch | DatabaseConnectionInfo,
  ConfigError,
  never
> = makeTursoCloudLive()
