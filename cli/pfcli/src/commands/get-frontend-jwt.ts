import { Console, Data, Effect } from "effect"
import { readFrontendJwt } from "@pf/auth-api"
import { getClientId } from "@pf/auth-session"
import { DATABASE_PATH_NOT_CONFIGURED, resolveDatabasePath } from "@pf/db-info"
import { makeFrontendJwtStorageLayer } from "../utils/frontend-jwt-storage-layer"

class FrontendJwtNotFoundError extends Data.TaggedError(
  "FrontendJwtNotFoundError",
)<{
  readonly message: string
}> {}

/**
 * Get frontend JWT command - reads stored frontend JWT token from database.
 *
 * @param orgPath - Path to organisation directory (to resolve database path)
 */
export const runGetFrontendJwt = (orgPath: string) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      yield* Console.error(DATABASE_PATH_NOT_CONFIGURED)
      return yield* new FrontendJwtNotFoundError({
        message: "Database path not configured",
      })
    }

    const appLayer = makeFrontendJwtStorageLayer(databasePath)

    const token = yield* readFrontendJwt(getClientId()).pipe(
      Effect.provide(appLayer),
    )

    if (!token) {
      yield* Console.error(
        "No frontend JWT found. Run 'pfcli import' or 'pfcli refresh-frontend-jwt' to create one.",
      )
      return yield* new FrontendJwtNotFoundError({
        message: "No frontend JWT found",
      })
    }

    // Write raw token to stdout (no newline) for shell substitution
    yield* Effect.sync(() => process.stdout.write(token))
  })
