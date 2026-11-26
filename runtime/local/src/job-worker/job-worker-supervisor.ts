import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { LOCAL_SQLITE_BUSY_TIMEOUT_MS } from "@pf/db-info"
import { UserDetails } from "@pf/graphql-db-operations"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import { makeLocalSqlClientLayer } from "../services/local-sql-client-layer"
import { observeQueueHealth } from "./queue-health"
import { superviseWorker } from "./worker-supervisor"

const extension = import.meta.url.endsWith(".ts") ? "ts" : "mjs"
const watch = process.argv.includes("--watch-worker")
const args = process.argv.slice(2).filter((arg) => arg !== "--watch-worker")
const controller = new AbortController()
const observationLayer = SqliteQueueServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      TypedSqliteDrizzleLayer.pipe(
        Layer.provideMerge(
          makeLocalSqlClientLayer({
            busy_timeout: LOCAL_SQLITE_BUSY_TIMEOUT_MS,
          }),
        ),
      ),
      Layer.succeed(RequestTime, DateTime.nowUnsafe()),
      Layer.succeed(UserDetails, { by: "SYSTEM", id: "queue-observer" }),
    ),
  ),
)
process.once("SIGTERM", () => controller.abort())
process.once("SIGINT", () => controller.abort())
const exit = await Effect.runPromiseExit(
  superviseWorker({
    observe: (publish) =>
      Effect.forever(
        observeQueueHealth(publish).pipe(
          Effect.provide(observationLayer),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              publish({
                status: "unavailable",
                sampledAt: DateTime.formatIso(DateTime.nowUnsafe()),
                error: Cause.pretty(cause),
              }),
            ),
          ),
          Effect.andThen(Effect.sleep(1000)),
        ),
      ),
    command: [
      process.execPath,
      ...(watch ? ["--watch"] : []),
      fileURLToPath(new URL(`./job-worker.${extension}`, import.meta.url)),
      ...args,
    ],
    stateFile:
      process.env["PF_LOCAL_QUEUE_STATE_FILE"] ||
      resolve(
        process.env["PF_RUNTIME_ROOT"] ?? process.cwd(),
        ".queue-worker-state.json",
      ),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError("Local queue supervision failed", error),
    ),
  ),
  { signal: controller.signal },
)
if (Exit.isFailure(exit) && !controller.signal.aborted) process.exitCode = 1
